const { EmbedBuilder } = require('discord.js');

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

module.exports = {
    base,
    success,
    error,
    warn,
    COLOR_PRIMARY,
    COLOR_SUCCESS,
    COLOR_ERROR,
    COLOR_WARN,
    FOOTER,
};
