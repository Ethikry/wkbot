const SHAME_LINES = [
    "Today's not your day. Yesterday wasn't either.",
    "WaniKani is going to file a missing person report.",
    "Even N5 sounds ambitious right now.",
    "ご苦労さん — said no one to you today.",
    "The sloth has nothing on you.",
    "Procrastination 100, kanji 0.",
    "Your reviews are aging like fine wine. Unfortunately you're not drinking them.",
    "Crabigator is disappointed.",
    "勉強しろ。Or don't. Suit yourself.",
    "At this rate, your kanji will be Burned by the time you're 90.",
];

function pickShameLine() {
    return SHAME_LINES[Math.floor(Math.random() * SHAME_LINES.length)];
}

module.exports = { pickShameLine, SHAME_LINES };
