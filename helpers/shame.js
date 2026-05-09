const SHAME_LINES = [
    [
        "えー？{user}、まだ今日のワニカニのレビュー終わってないの？",
        "ざこ〜。漢字たち、ずっと待ってるよってカニーちゃん見てるんだけど？",
        "ピンクのレビューぼたんに負けてるの？カニーちゃん、はやく終わらせてほしいなぁ💢",
    ],
    [
        "わあ、{user}、今日のレビュー目ひょう、まだ終わってないんだ〜。",
        "漢字こわかったの？だいじょうぶ、カニーちゃんがついてるよ、せんぱい。",
        "レビューざこでも、今からならまだまにあうって、カニーちゃんは信じてるよ💢",
    ],
    [
        "あれ〜？{user}、レビュー目ひょう、まだのこってるの？",
        "かわいい〜。SRSがいつまでも待ってくれるって、カニーちゃんに思わせないで？",
        "今日は語いカードにいじめられないって、カニーちゃんにしょうめいしてよね💢",
    ],
    [
        "{user}、目ひょう未かん了？えへへ〜、カニーちゃん、レビューざこ発見しちゃった。",
        "漢字にわらわれる前に、ワニカニのキューを消してきてって、カニーちゃんがおねがい💢",
    ],
    [
        "えー？{user}、今日まだ{completed}/{goal}レビューしかしてないの？",
        "ざこ〜。漢字は自分でバーンしないって、カニーちゃん何回も言ってるよ。",
        "見習いアイテムに弱いって言われる前に、目ひょう終わらせてって、カニーちゃんからのお願い💢",
    ],
    [
        "えー、{user}……まだ今日のレビュー{completed}/{goal}なの？",
        "ざこ〜。ちょっとの漢字でにげたとか、カニーちゃんに言わないよね？",
        "キューを消して、SRSにいじめられてないって、カニーちゃんにしょうめいしてよ💢",
    ],
];

function pickShameLine({ user, completed, goal } = {}) {
    const eligible = SHAME_LINES.filter(block => {
        const text = block.join('');
        if (text.includes('{completed}') && completed == null) return false;
        if (text.includes('{goal}') && goal == null) return false;
        return true;
    });
    const pool = eligible.length ? eligible : SHAME_LINES;
    const block = pool[Math.floor(Math.random() * pool.length)];
    return block.map(line =>
        line
            .replaceAll('{user}', user ?? 'せんぱい')
            .replaceAll('{completed}', completed ?? '')
            .replaceAll('{goal}', goal ?? '')
    ).join('\n');
}

module.exports = { pickShameLine, SHAME_LINES };
