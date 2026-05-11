const { EmbedBuilder } = require('discord.js');
const { getBotTimeZone, recentDateKeys } = require('./botTime');

const COLOR_PRIMARY = 0xFF9900;
const COLOR_SUCCESS = 0x2ECC71;
const COLOR_ERROR = 0xE74C3C;
const COLOR_WARN = 0xF1C40F;
const FOOTER = { text: 'WaniKani Bot' };

function base(title) {
    return new EmbedBuilder()
        .setColor(COLOR_PRIMARY)
        .setTitle(title)
        .setTimestamp()
        .setFooter(FOOTER);
}

function success(title, description) {
    return new EmbedBuilder()
        .setColor(COLOR_SUCCESS)
        .setTitle(title)
        .setDescription(description ?? null)
        .setTimestamp()
        .setFooter(FOOTER);
}

function error(title, description) {
    return new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setTitle(title)
        .setDescription(description ?? null)
        .setTimestamp()
        .setFooter(FOOTER);
}

function warn(title, description) {
    return new EmbedBuilder()
        .setColor(COLOR_WARN)
        .setTitle(title)
        .setDescription(description ?? null)
        .setTimestamp()
        .setFooter(FOOTER);
}

function bucketEmoji(reviews) {
    if (reviews === 0) return '⬛';
    if (reviews < 20) return '🟦';
    if (reviews < 50) return '🟩';
    if (reviews < 100) return '🟨';
    if (reviews < 200) return '🟧';
    return '🟥';
}

function renderMonthlyHeatmap(snapshotsByDate, days = 30, columns = 6, timeZone = getBotTimeZone()) {
    const cells = recentDateKeys(days, timeZone).map(dateStr =>
        bucketEmoji(snapshotsByDate.get(dateStr) ?? 0).repeat(3)
    );
    const rows = [];
    for (let i = 0; i < cells.length; i += columns) {
        rows.push(cells.slice(i, i + columns).join(''));
    }
    return rows.join('\n');
}

const HEATMAP_LEGEND = '⬛ none · 🟦 <20 · 🟩 <50 · 🟨 <100 · 🟧 <200 · 🟥 200+';

module.exports = {
    base,
    success,
    error,
    warn,
    renderMonthlyHeatmap,
    HEATMAP_LEGEND,
    COLOR_PRIMARY,
    COLOR_SUCCESS,
    COLOR_ERROR,
    COLOR_WARN,
    FOOTER,
};
