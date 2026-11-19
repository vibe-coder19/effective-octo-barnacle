# GLM-5.3 roleplay prompt for SillyTavern

A system prompt plus a short end-of-chat reminder for GLM-5.3, tuned for:

- staying in character (voice, knowledge limits, the character's own agenda)
- vivid scenes and detailed physical appearance
- realism without positivity bias
- short user messages: one beat per reply, at most one question
- NPCs who speak and act when the scene needs them

## Files

| File | Use |
|---|---|
| `GLM-5.3 Roleplay.json` | Chat Completion preset with both prompts and the sampler settings. Import this. |
| `main-prompt.txt` | The system prompt, for pasting by hand into Main Prompt. |
| `post-history-instructions.txt` | The reminder that goes after the chat history (Post-History Instructions). |
| `GLM-5.3 Roleplay (Text Completion system prompt).json` | The same two prompts as a System Prompt preset, for Text Completion mode. |

## Setup (Chat Completion)

1. **API Connections:** set API to Chat Completion. Pick **Z.AI** as the source with model `glm-5.3`, or OpenRouter, NanoGPT or Custom (OpenAI-compatible) for another host or a local server. In Chat Completion mode the backend applies GLM's own chat template, so the prompt reaches the model in the format it was trained on.
2. **Same panel:** set **Prompt Post-Processing** to **Semi-strict (alternating roles; no tools)**. This merges the system blocks into one system message at the top and attaches the reminder to your latest message, where GLM-5.x pays the most attention. Community GLM-5 presets treat this setting as essential.
3. **AI Response Configuration** (sliders icon): click **Import preset** and choose `GLM-5.3 Roleplay.json`. It only sets prompts and samplers. Your API source, model, context size and streaming stay as they are.

What the preset sets:

| Setting | Value | Why |
|---|---|---|
| Temperature / Top P | 1.0 / 0.95 | What Z.ai used for most of its published GLM-5 evaluations |
| Other samplers and penalties | neutral | The Z.AI source doesn't send frequency or presence penalties anyway |
| Max Response Length | 4096 | Thinking tokens count toward this on most providers. Set it too low and replies come back cut off or empty. Reply length is controlled by the prompt, not by this number. |
| Request model reasoning | on | On the Z.AI source this switches GLM's thinking on. The prompt's "Before Each Reply" checklist runs in that thinking. |
| Forbid overrides | on (Main Prompt and Post-History Reminder) | A character card's own system prompt can't silently replace yours |

The preset doesn't set context size. For roleplay, 32k to 64k tokens is a sensible range; longer chats get slower and more expensive, and the instructions carry less weight.

### Text Completion instead

In Advanced Formatting, under System Prompt, import `GLM-5.3 Roleplay (Text Completion system prompt).json` and enable it. It fills both the System Prompt and its Post-History Instructions. You'll also need an instruct template that matches GLM's chat format. Chat Completion skips that step, which is why it's the recommended mode.

## Tuning

- **Reply length:** change `150-300 words` in both prompts (Main Prompt and Post-History Reminder).
- **More appearance detail:** under Vivid Physical Description, change "at least one concrete detail" to "two or three".
- **Characters too harsh:** if characters turn cold for no reason, the card and the realism rules are probably stacking. Delete a bullet or two from Realism Over Positivity.
- **A habit keeps coming back** (echoing your message, a pet phrase): add the exact phrase to the stock-phrase list under Style.
- **You want a card's own system prompt:** untick "Forbid overrides" on the Main Prompt.

## Troubleshooting

- **Empty or cut-off replies:** raise Max Response Length. The thinking used up the budget.
- **Raw `<think>` text in replies** (local backends without a reasoning parser): in Advanced Formatting, under Reasoning, turn on Auto-Parse.
- **Swipes nearly identical:** some users report that Z.ai's coding endpoint ignores temperature unless `do_sample: true` is sent. The Z.AI source can't add extra body fields, so switch to Custom (OpenAI-compatible) and put `do_sample: true` under Include Body Parameters.

## Why this format

Z.ai doesn't publish a recommended prompt format for roleplay. GLM-5.3's post-training was mostly agentic coding work, where system prompts are written as Markdown headers with short bullet lists. So the prompt opens with a short prose statement of the role, followed by headed sections of one-idea bullets that the model's thinking can check one at a time. Rules are stated positively. Concrete "don't" examples are used only for habits GLM models are known for in roleplay: echoing your message, stock phrases, characters reading your mind, and positivity or moralizing. The reminder after the chat history repeats only the rules that drift over long chats: length, one question, an appearance detail, and never writing for you.
