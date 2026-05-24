/*jslint node: true */
'use strict';

const Homey = require('homey');

module.exports = {
    async sendLog({ homey, body })
    {
        return await homey.app.sendLog(body);
    },

    async getRateStats({ homey })
    {
        return homey.app.getRateStats();
    },

    async clearPeakRate({ homey })
    {
        return homey.app.clearPeakRate();
    }
};