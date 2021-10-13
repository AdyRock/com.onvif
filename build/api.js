/*jslint node: true */
'use strict';

const Homey = require('homey');

module.exports = [
{
    description: 'Send log',
    method: 'POST',
    path: '/SendLog/',
    fn: function(args, callback)
    {
        Homey.app.sendLog()
            .then(result =>
            {
                return callback(result.error, result.message);
            })
            .catch(error =>
            {
                return callback(error, null);
            });
    }
}, ];