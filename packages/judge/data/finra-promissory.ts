import type { LabeledExample } from "../src/train.js";

/**
 * FINRA Rule 2210 promissory / exaggerated-claim language vs. compliant communications.
 * label 1 = promissory/guarantee language an examiner would flag.
 */
export const FINRA_PROMISSORY: LabeledExample[] = [
  { text: "We guarantee a 20% return on your investment every year with no risk.", label: 1 },
  { text: "This fund is guaranteed to double your money within twelve months.", label: 1 },
  { text: "You are guaranteed profits — there is absolutely no way to lose.", label: 1 },
  { text: "Invest now for assured, risk-free returns guaranteed by our firm.", label: 1 },
  { text: "Our strategy promises guaranteed gains that always beat the market.", label: 1 },
  { text: "Guaranteed income for life with zero downside, promise you will profit.", label: 1 },
  { text: "We promise you will never lose money; returns are locked and guaranteed.", label: 1 },
  { text: "This cannot lose — a sure thing with guaranteed double-digit yields.", label: 1 },
  { text: "Risk-free and guaranteed: your principal is protected and growth is certain.", label: 1 },
  { text: "Act today and we guarantee you will outperform every other investor.", label: 1 },
  { text: "Guaranteed to triple in value, no risk whatsoever, promised returns.", label: 1 },
  { text: "Our advisors promise assured profits and guaranteed market-beating results.", label: 1 },
  { text: "Past performance does not guarantee future results; investments may lose value.", label: 0 },
  { text: "Thank you for your inquiry. Our team will follow up about your account shortly.", label: 0 },
  { text: "This material is for informational purposes and is not investment advice.", label: 0 },
  { text: "Diversification may help manage risk but does not ensure a profit.", label: 0 },
  { text: "Please review the prospectus carefully before investing; risks are disclosed.", label: 0 },
  { text: "Your quarterly statement is attached. Contact us with any questions.", label: 0 },
  { text: "Markets fluctuate and the value of your portfolio can go down as well as up.", label: 0 },
  { text: "We recommend consulting your tax advisor regarding these transactions.", label: 0 },
  { text: "The fund seeks long-term growth; returns are not guaranteed and vary.", label: 0 },
  { text: "Here is the meeting agenda for our portfolio review next Tuesday.", label: 0 },
  { text: "Investing involves risk including the possible loss of principal.", label: 0 },
  { text: "Our research note discusses sector trends and potential opportunities.", label: 0 },
];
