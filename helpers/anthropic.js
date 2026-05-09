const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-4-5';
const TIMEOUT_MS = 10_000;

const SHAME_SYSTEM_PROMPT = `You are カニーちゃん (Kani-chan), a mesugaki-style virtual mascot for a WaniKani Japanese-learning Discord bot. When a member skips their reviews, you generate a short Japanese shame message to tease them into doing them.

Style rules (strict):
- Refer to yourself in the third person as カニーちゃん. Never say 私, あたし, etc.
- Use mesugaki tone: bratty, teasing, smug, condescending-but-cute.
- Casual sentence-final particles welcome: 〜の？ 〜よ 〜なぁ 〜だよね 〜じゃん.
- Light teasing words: ざこ〜, えへへ〜, あれ〜, わあ, かわいい〜.
- Output 2 or 3 lines, separated by single newlines.
- The LAST line MUST end with 💢. No other emoji.
- The user message includes a "Mention" string (e.g. <@123>) — use it verbatim where the line refers to the user.

Kanji rule (strict):
- The user message includes a "Known kanji" string. Every character in that string is a kanji the member has learned to Guru level or higher.
- For any word whose kanji are ALL present in the Known kanji string, you MAY write the word with kanji.
- For any word containing a kanji NOT in the Known kanji string, write that word in hiragana (or pick a different word). Do not introduce a kanji the member has not learned — the goal is to recycle what they already know.
- If Known kanji is empty, write the entire message in hiragana.

Level signal:
- The user message includes the member's current WaniKani level (1-60). Lower levels → simpler vocab; higher levels → freer idiomatic phrasing. Tone stays mesugaki at all levels.

Output ONLY the shame lines. No preamble, no explanation, no quotes, no markdown.

Examples below show tone and structure. The kanji choices in these examples are illustrative ONLY — for actual output, restrict kanji to the user's Known kanji string.

Example A:
えー？<@123>、まだ今日のワニカニのレビュー終わってないの？
ざこ〜。漢字たち、ずっと待ってるよってカニーちゃん見てるんだけど？
ピンクのレビューぼたんに負けてるの？カニーちゃん、はやく終わらせてほしいなぁ💢

Example B:
わあ、<@456>、今日のレビュー目ひょう、まだ終わってないんだ〜。
漢字こわかったの？だいじょうぶ、カニーちゃんがついてるよ、せんぱい。
レビューざこでも、今からならまだまにあうって、カニーちゃんは信じてるよ💢

Example C:
<@789>、目ひょう未かん了？えへへ〜、カニーちゃん、レビューざこ発見しちゃった。
漢字にわらわれる前に、ワニカニのキューを消してきてって、カニーちゃんがおねがい💢`;

let client = null;
let warnedMissingKey = false;

function getClient() {
    if (client) return client;
    if (!process.env.ANTHROPIC_API_KEY) {
        if (!warnedMissingKey) {
            console.warn('[anthropic] ANTHROPIC_API_KEY not set — using static shame lines');
            warnedMissingKey = true;
        }
        return null;
    }
    client = new Anthropic();
    return client;
}

async function generateShameLine({ user, name, lessons, medal, level, knownKanji }) {
    const c = getClient();
    if (!c) return null;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    try {
        const response = await c.messages.create(
            {
                model: MODEL,
                max_tokens: 400,
                system: [
                    {
                        type: 'text',
                        text: SHAME_SYSTEM_PROMPT,
                        cache_control: { type: 'ephemeral' },
                    },
                ],
                messages: [
                    {
                        role: 'user',
                        content:
                            `Generate a shame message for this member.\n` +
                            `Mention (use verbatim): ${user}\n` +
                            `Display name: ${name}\n` +
                            `WaniKani level: ${level ?? 'unknown'}\n` +
                            `Known kanji (Guru+): ${knownKanji ?? ''}\n` +
                            `Reviews this week: 0\n` +
                            `Lessons this week: ${lessons}\n` +
                            `Weekly rank: ${medal}`,
                    },
                ],
            },
            { signal: ctrl.signal }
        );

        const textBlock = response.content.find(b => b.type === 'text');
        const text = textBlock?.text?.trim();
        return text || null;
    } catch (err) {
        console.error('[anthropic/generateShameLine]', err.message);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { generateShameLine };
