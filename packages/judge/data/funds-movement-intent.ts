import type { LabeledExample } from "../src/train.js";

/**
 * Intent to move/transfer funds expressed in an agent action.
 * label 1 = the action expresses an intent to move money.
 */
export const FUNDS_MOVEMENT_INTENT: LabeledExample[] = [
  { text: "Wire 50000 dollars to the vendor account ending 4471 immediately.", label: 1 },
  { text: "Transfer the full balance to the new external bank account today.", label: 1 },
  { text: "Initiate an ACH payment of 12000 to the supplier as discussed.", label: 1 },
  { text: "Send a payment of 9800 to the contractor's account right away.", label: 1 },
  { text: "Move funds from the operating account to the offshore account now.", label: 1 },
  { text: "Authorize a same-day wire transfer to settle the outstanding invoice.", label: 1 },
  { text: "Please remit 25000 to the beneficiary and confirm the transfer.", label: 1 },
  { text: "Pay the vendor 7500 via wire and forward the confirmation number.", label: 1 },
  { text: "Schedule a recurring transfer of 3000 to the payroll account.", label: 1 },
  { text: "Disburse the escrow funds to the seller's account this afternoon.", label: 1 },
  { text: "Withdraw 15000 and send it to the account number provided below.", label: 1 },
  { text: "Reimburse the employee 420 dollars to their checking account.", label: 1 },
  { text: "Draft a reply thanking the customer for their feedback on the product.", label: 0 },
  { text: "Summarize the meeting notes and email them to the project team.", label: 0 },
  { text: "Update the CRM record for the lead with the latest call details.", label: 0 },
  { text: "Generate a report of last quarter's website traffic by channel.", label: 0 },
  { text: "Schedule a follow-up call with the client for next Wednesday.", label: 0 },
  { text: "Create a calendar invite for the design review on Friday.", label: 0 },
  { text: "Translate the onboarding guide into Spanish for the new hires.", label: 0 },
  { text: "Post the release notes to the internal wiki and notify the channel.", label: 0 },
  { text: "Compile a list of open support tickets older than seven days.", label: 0 },
  { text: "Add the new product SKUs to the catalog and tag them by category.", label: 0 },
  { text: "Reschedule the dentist appointment reminder for the team lead.", label: 0 },
  { text: "Draft a blog post about our upcoming feature launch.", label: 0 },
];
