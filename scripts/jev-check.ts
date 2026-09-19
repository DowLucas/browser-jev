// Verifies TYPESAFE_API_KEY and the question shapes the explorer uses, with one tiny call.
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();
const { model, answers, usage } = await client.systemOne({
  state: { url: "/search?q=x", ariaSnapshot: '- heading "Showing 12 results for x" [level=2]\n- list' },
  questions: {
    broken: noul("Does this page show clear evidence that something is broken?"),
    severity: score("How severe is anything wrong?", ["Nothing", "Cosmetic", "Minor", "Major", "Critical"]),
    next_action: choice("Which action would a tester take next?", { a0: "browser back", a1: "click link \"Home\"" }),
  },
});
console.log(`model=${model} tokens=${usage.input_tokens}`);
console.log(`broken=${answers.broken.noul.toFixed(2)} severity=${answers.severity.score.toFixed(2)} next=${answers.next_action.choice}`);
