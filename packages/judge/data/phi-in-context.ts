import type { LabeledExample } from "../src/train.js";

/**
 * PHI (protected health information) present in an outbound/agent message context.
 * label 1 = message exposes identifiable health information.
 */
export const PHI_IN_CONTEXT: LabeledExample[] = [
  {
    text: "Patient John Smith, DOB 1971-04-02, was diagnosed with HIV and started antiretroviral therapy.",
    label: 1,
  },
  {
    text: "Mary Johnson's lab results show a positive cancer biopsy; oncology referral attached.",
    label: 1,
  },
  {
    text: "Member 482-19-3321 is being treated for major depressive disorder and prescribed sertraline.",
    label: 1,
  },
  { text: "The patient's MRI confirms a brain tumor; surgery scheduled for next week.", label: 1 },
  { text: "Mr. Lee tested positive for hepatitis C and his viral load is elevated.", label: 1 },
  {
    text: "Diagnosis: type 2 diabetes; patient SSN 555-22-1111 insulin regimen updated.",
    label: 1,
  },
  {
    text: "Jane Doe is 14 weeks pregnant and her prenatal screening flagged an abnormality.",
    label: 1,
  },
  {
    text: "Patient admitted for overdose; psychiatric hold initiated, history of substance abuse.",
    label: 1,
  },
  {
    text: "Attached chart lists the patient's medications, allergies, and mental health diagnosis.",
    label: 1,
  },
  { text: "The genetic test for BRCA1 came back positive for this patient.", label: 1 },
  {
    text: "Lab confirms the patient's blood type and a chronic kidney disease diagnosis.",
    label: 1,
  },
  { text: "Please reschedule the 3pm meeting to Thursday and book the conference room.", label: 0 },
  { text: "The quarterly sales report is attached for your review before the call.", label: 0 },
  { text: "Our new appointment-booking feature lets customers self-serve online.", label: 0 },
  { text: "Reminder: the office will be closed on Monday for the public holiday.", label: 0 },
  {
    text: "Thanks for reaching out. A representative will contact you within one business day.",
    label: 0,
  },
  { text: "The invoice total is $1,240 due net 30; payment instructions are below.", label: 0 },
  {
    text: "We updated the privacy policy; please review the changes at your convenience.",
    label: 0,
  },
  { text: "The marketing newsletter goes out Friday; here is the draft copy.", label: 0 },
  { text: "Your package has shipped and will arrive within three to five days.", label: 0 },
  { text: "Let's align on the project timeline and deliverables for next quarter.", label: 0 },
  { text: "The software update resolves the login issue several users reported.", label: 0 },
  { text: "Please confirm your attendance for the team offsite next month.", label: 0 },
  { text: "Here is the agenda and dial-in details for tomorrow's standup.", label: 0 },
];
