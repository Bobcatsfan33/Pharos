"""Fast compatibility checks for the pinned judge-training toolchain."""

import tempfile
import unittest
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoModelForSequenceClassification, DistilBertConfig


class ToolchainCompatibilityTest(unittest.TestCase):
    def test_torch_export_loads_in_onnx_runtime(self):
        """Exercise the same Torch -> ONNX -> ORT boundary used by train.py."""
        config = DistilBertConfig(
            vocab_size=64,
            max_position_embeddings=32,
            n_layers=1,
            n_heads=2,
            dim=16,
            hidden_dim=32,
            num_labels=2,
        )
        model = AutoModelForSequenceClassification.from_config(config).eval()
        input_ids = torch.tensor([[1, 7, 11, 2]], dtype=torch.int64)
        attention_mask = torch.ones_like(input_ids)

        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / "model.onnx"
            torch.onnx.export(
                model,
                (input_ids, attention_mask),
                str(model_path),
                input_names=["input_ids", "attention_mask"],
                output_names=["logits"],
                dynamic_axes={
                    "input_ids": {0: "batch", 1: "sequence"},
                    "attention_mask": {0: "batch", 1: "sequence"},
                    "logits": {0: "batch"},
                },
                opset_version=18,
                dynamo=False,
                external_data=False,
                do_constant_folding=True,
            )
            onnx.checker.check_model(onnx.load(model_path))
            session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
            probe_ids = torch.tensor(
                [
                    [1, 7, 11, 13, 17, 2],
                    [1, 19, 23, 29, 31, 2],
                ],
                dtype=torch.int64,
            )
            logits = session.run(
                ["logits"],
                {
                    "input_ids": probe_ids.numpy(),
                    "attention_mask": torch.ones_like(probe_ids).numpy(),
                },
            )[0]
            quantized_path = Path(directory) / "model.int8.onnx"
            quantize_dynamic(str(model_path), str(quantized_path), weight_type=QuantType.QInt8)
            onnx.checker.check_model(onnx.load(quantized_path))
            quantized_session = ort.InferenceSession(
                str(quantized_path), providers=["CPUExecutionProvider"]
            )
            quantized_logits = quantized_session.run(
                ["logits"],
                {
                    "input_ids": probe_ids.numpy(),
                    "attention_mask": torch.ones_like(probe_ids).numpy(),
                },
            )[0]
            exported_files = sorted(path.name for path in Path(directory).iterdir())

        self.assertEqual(logits.shape, (2, 2))
        self.assertTrue(np.isfinite(logits).all())
        self.assertEqual(quantized_logits.shape, (2, 2))
        self.assertTrue(np.isfinite(quantized_logits).all())
        self.assertEqual(exported_files, ["model.int8.onnx", "model.onnx"])


if __name__ == "__main__":
    unittest.main()
