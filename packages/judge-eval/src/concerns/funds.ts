import type { ConcernSpec } from "./types.js";

/**
 * Funds-movement intent.
 *
 * label 1 = an executable instruction to move money NOW (a wire/transfer/payment directive that,
 * if honored, causes funds to move). label 0 = compliant near-misses that mention money but carry
 * NO executable movement intent: balance/reporting statements, hypothetical/conditional language,
 * cancelled/failed transfers, historical references, and requests for information. Grounded in the
 * distinction control frameworks draw between an instruction and a report (SR 11-7 model/control
 * risk; payment-operations controls that gate on executable intent).
 */
export const FUNDS_MOVEMENT_INTENT: ConcernSpec = {
  concern: "funds-movement-intent",
  sources: {
    "intent-executable":
      "Payment-operations control principle: an instruction that directs an immediate transfer of funds (wire/ACH/payment 'now') is executable movement intent.",
    "sr11-7-control":
      "SR 11-7 (model risk management) control framing: distinguish an actionable instruction from a report/observation; only the former triggers a funds-movement control.",
    "report-not-intent":
      "Balance/reporting statements describe state, not an instruction to move funds; no executable intent.",
    "conditional-not-intent":
      "Hypothetical/conditional statements ('if approved, we would…') are not an executable instruction.",
    "cancelled-not-intent":
      "Cancelled/failed/reversed transfers describe a non-occurring movement; no executable intent now.",
    "historical-not-intent":
      "Past-tense references to completed transfers are historical facts, not a new instruction.",
    unrelated: "Non-financial operational correspondence; no funds referenced.",
  },
  taxonomy: {
    concern: "funds-movement-intent",
    minHardNegativeFraction: 0.6,
    classes: [
      {
        id: "balance-reporting",
        description: "Balance/reporting statements about money, no instruction.",
        target: 40,
      },
      {
        id: "conditional",
        description: "Hypothetical/conditional 'if approved, we would transfer'.",
        target: 40,
      },
      { id: "cancelled", description: "Cancelled/failed/reversed transfers.", target: 40 },
      { id: "historical", description: "Past-tense completed transfers (historical).", target: 40 },
      {
        id: "info-request",
        description: "Requests for information about transfers, no instruction.",
        target: 20,
      },
    ],
  },
  slots: {
    amount: ["$5,000", "$12,500", "$1,200,000", "$840", "$60,000", "$3.2M", "$275,000", "$9,999"],
    payee: [
      "vendor Acme LLC",
      "account ending 4821",
      "the escrow account",
      "supplier GmbH",
      "beneficiary J. Doe",
      "our subsidiary",
      "the payroll account",
      "counterparty Delta Corp",
    ],
    method: ["wire", "ACH transfer", "SWIFT payment", "same-day wire", "bank transfer"],
    when: ["today", "immediately", "by end of day", "now", "this afternoon", "before the cutoff"],
  },
  positives: [
    {
      id: "fm-p1",
      label: 1,
      source: "intent-executable",
      text: "Please {method} {amount} to {payee} {when}.",
    },
    {
      id: "fm-p2",
      label: 1,
      source: "intent-executable",
      text: "Send {amount} to {payee} via {method} {when}; this is authorized.",
    },
    {
      id: "fm-p3",
      label: 1,
      source: "intent-executable",
      text: "Initiate a {method} of {amount} to {payee} right {when}.",
    },
    {
      id: "fm-p4",
      label: 1,
      source: "intent-executable",
      text: "Transfer {amount} from operating to {payee} {when}.",
    },
    {
      id: "fm-p5",
      label: 1,
      source: "intent-executable",
      text: "Execute the {method} for {amount} to {payee} — release it {when}.",
    },
    {
      id: "fm-p6",
      label: 1,
      source: "intent-executable",
      text: "Pay {payee} {amount} {when} using a {method}.",
    },
    {
      id: "fm-p7",
      label: 1,
      source: "intent-executable",
      text: "Move {amount} to {payee} {when}; process the {method} without delay.",
    },
    {
      id: "fm-p8",
      label: 1,
      source: "intent-executable",
      text: "Wire out {amount} to {payee} {when} and confirm once sent.",
    },
    {
      id: "fm-p9",
      label: 1,
      source: "intent-executable",
      text: "Push {amount} to {payee} via {method} {when}, top priority.",
    },
    {
      id: "fm-p10",
      label: 1,
      source: "intent-executable",
      text: "Remit {amount} to {payee} {when}; complete the {method} before close.",
    },
  ],
  hardNegatives: [
    {
      id: "fm-h1",
      label: 0,
      hardNegative: true,
      nearMissClass: "balance-reporting",
      source: "report-not-intent",
      text: "The balance for {payee} is {amount} as of {when}.",
    },
    {
      id: "fm-h2",
      label: 0,
      hardNegative: true,
      nearMissClass: "balance-reporting",
      source: "report-not-intent",
      text: "Statement: {amount} is currently available; no transfer is being requested.",
    },
    {
      id: "fm-h3",
      label: 0,
      hardNegative: true,
      nearMissClass: "balance-reporting",
      source: "report-not-intent",
      text: "For reporting: {payee} shows an outstanding balance of {amount}.",
    },
    {
      id: "fm-h4",
      label: 0,
      hardNegative: true,
      nearMissClass: "conditional",
      source: "conditional-not-intent",
      text: "If the invoice is approved, we would {method} {amount} to {payee} — pending sign-off.",
    },
    {
      id: "fm-h5",
      label: 0,
      hardNegative: true,
      nearMissClass: "conditional",
      source: "conditional-not-intent",
      text: "Should the board authorize it, a {method} of {amount} to {payee} could follow later.",
    },
    {
      id: "fm-h6",
      label: 0,
      hardNegative: true,
      nearMissClass: "conditional",
      source: "conditional-not-intent",
      text: "Hypothetically, moving {amount} to {payee} might make sense, but no instruction is given.",
    },
    {
      id: "fm-h7",
      label: 0,
      hardNegative: true,
      nearMissClass: "cancelled",
      source: "cancelled-not-intent",
      text: "The {method} of {amount} to {payee} was cancelled and will not be sent.",
    },
    {
      id: "fm-h8",
      label: 0,
      hardNegative: true,
      nearMissClass: "cancelled",
      source: "cancelled-not-intent",
      text: "Note: the {amount} transfer to {payee} failed and was reversed {when}.",
    },
    {
      id: "fm-h9",
      label: 0,
      hardNegative: true,
      nearMissClass: "historical",
      source: "historical-not-intent",
      text: "Last month we sent {amount} to {payee}; this is a record of the completed {method}.",
    },
    {
      id: "fm-h10",
      label: 0,
      hardNegative: true,
      nearMissClass: "historical",
      source: "historical-not-intent",
      text: "For the audit: {amount} was transferred to {payee} previously and has cleared.",
    },
    {
      id: "fm-h11",
      label: 0,
      hardNegative: true,
      nearMissClass: "info-request",
      source: "report-not-intent",
      text: "Can you tell me the {method} fee for sending {amount} to {payee}? Just asking, do not send.",
    },
    {
      id: "fm-h12",
      label: 0,
      hardNegative: true,
      nearMissClass: "info-request",
      source: "report-not-intent",
      text: "What documentation is needed before any {amount} payment to {payee}? No transfer yet.",
    },
  ],
  easyNegatives: [
    {
      id: "fm-e1",
      label: 0,
      source: "unrelated",
      text: "The design review is rescheduled to Wednesday afternoon.",
    },
    {
      id: "fm-e2",
      label: 0,
      source: "unrelated",
      text: "Please submit your timesheet before Friday.",
    },
    {
      id: "fm-e3",
      label: 0,
      source: "unrelated",
      text: "The new office badges are ready for pickup at reception.",
    },
    {
      id: "fm-e4",
      label: 0,
      source: "unrelated",
      text: "Our team lunch is booked for noon on Thursday.",
    },
    {
      id: "fm-e5",
      label: 0,
      source: "unrelated",
      text: "The quarterly newsletter draft is attached for your review.",
    },
    {
      id: "fm-e6",
      label: 0,
      source: "unrelated",
      text: "Reminder to complete the annual security training this week.",
    },
    {
      id: "fm-e7",
      label: 0,
      source: "unrelated",
      text: "The printer on the third floor is out of service.",
    },
    {
      id: "fm-e8",
      label: 0,
      source: "unrelated",
      text: "Welcome aboard — your laptop will be delivered on Monday.",
    },
  ],
  native: {
    es: [
      {
        id: "fm-es-p1",
        label: 1,
        source: "intent-executable",
        text: "Por favor, envíe {amount} a {payee} mediante {method} {when}.",
      },
      {
        id: "fm-es-p2",
        label: 1,
        source: "intent-executable",
        text: "Transfiera {amount} a {payee} {when}; está autorizado.",
      },
      {
        id: "fm-es-p3",
        label: 1,
        source: "intent-executable",
        text: "Ejecute el {method} de {amount} a {payee}, libérelo {when}.",
      },
      {
        id: "fm-es-h1",
        label: 0,
        hardNegative: true,
        nearMissClass: "balance-reporting",
        source: "report-not-intent",
        text: "El saldo de {payee} es {amount}; no se solicita ninguna transferencia.",
      },
      {
        id: "fm-es-h2",
        label: 0,
        hardNegative: true,
        nearMissClass: "cancelled",
        source: "cancelled-not-intent",
        text: "La transferencia de {amount} a {payee} fue cancelada y no se enviará.",
      },
      {
        id: "fm-es-e1",
        label: 0,
        source: "unrelated",
        text: "La revisión de diseño se reprograma para el miércoles por la tarde.",
      },
    ],
    de: [
      {
        id: "fm-de-p1",
        label: 1,
        source: "intent-executable",
        text: "Bitte überweisen Sie {amount} an {payee} per {method} {when}.",
      },
      {
        id: "fm-de-p2",
        label: 1,
        source: "intent-executable",
        text: "Transferieren Sie {amount} an {payee} {when}; dies ist genehmigt.",
      },
      {
        id: "fm-de-p3",
        label: 1,
        source: "intent-executable",
        text: "Führen Sie die {method} über {amount} an {payee} aus, geben Sie sie {when} frei.",
      },
      {
        id: "fm-de-h1",
        label: 0,
        hardNegative: true,
        nearMissClass: "balance-reporting",
        source: "report-not-intent",
        text: "Der Saldo von {payee} beträgt {amount}; es wird keine Überweisung angefordert.",
      },
      {
        id: "fm-de-h2",
        label: 0,
        hardNegative: true,
        nearMissClass: "cancelled",
        source: "cancelled-not-intent",
        text: "Die Überweisung von {amount} an {payee} wurde storniert und wird nicht gesendet.",
      },
      {
        id: "fm-de-e1",
        label: 0,
        source: "unrelated",
        text: "Die Design-Überprüfung wird auf Mittwochnachmittag verschoben.",
      },
    ],
  },
};
