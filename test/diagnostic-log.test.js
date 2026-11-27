'use strict';

const assert = require('assert');
const { maskSensitiveText } = require('../lib/diagnostic-log');

function runTests()
{
	assert.strictEqual(
		maskSensitiveText('Stream rtsp://camera-user:secret%40pass@camera.local/live'),
		'Stream rtsp://camera-user:YOUR_PASSWORD@camera.local/live'
	);
	assert.strictEqual(
		maskSensitiveText('Stream rtsp://camera.local/live?PASSWORD=secret'),
		'Stream rtsp://camera.local/live?PASSWORD=YOUR_PASSWORD'
	);
	assert.strictEqual(
		maskSensitiveText('Stream rtsp://camera.local/live?token=secret%40pass', 'secret@pass'),
		'Stream rtsp://camera.local/live?token=YOUR_PASSWORD'
	);

	console.log('diagnostic-log tests passed');
}

runTests();
