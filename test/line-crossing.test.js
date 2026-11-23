'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const devicePath = path.join(__dirname, '..', 'drivers', 'camera', 'device.js');
const deviceRequire = createRequire(devicePath);
const deviceModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(devicePath, 'utf8'), {
	module: deviceModule,
	require: (name) =>
	{
		if (name === 'homey')
		{
			return { Device: class {} };
		}
		if (name === 'digest-fetch' || name === 'node-fetch')
		{
			return () => { throw new Error('Network access is not expected in these tests'); };
		}
		return deviceRequire(name);
	}
}, { filename: devicePath });
const CameraDevice = deviceModule.exports;

function createDevice(hasLineCrossed = true)
{
	const device = new CameraDevice();
	const values = { alarm_motion: true };
	if (hasLineCrossed)
	{
		values.alarm_line_crossed = true;
	}
	const timers = new Map();
	const errors = [];
	const motionEvents = [];
	let nextTimer = 0;
	let flowTriggers = 0;

	Object.assign(device, {
		homey: {
			app: { updateLog: () => {} },
			setTimeout: (callback, delay) =>
			{
				const id = ++nextTimer;
				timers.set(id, { callback, delay });
				return id;
			},
			clearTimeout: (id) => timers.delete(id)
		},
		driver: {
			eventLineCrossedTrigger: {
				trigger: async () => { flowTriggers += 1; }
			}
		},
		getSettings: () => ({
			ip: '192.0.2.1', port: 80, channel: -1, token: '',
			utc_time: false, classType: 'camera', objectID: ''
		}),
		getData: () => ({ id: 'test-camera' }),
		getStoreValue: () => null,
		getName: () => 'Test camera',
		getClass: () => 'camera',
		getEventTN: () => '',
		hasCapability: (name) => Object.prototype.hasOwnProperty.call(values, name),
		getCapabilityValue: (name) => values[name],
		setCapabilityValue: async (name, value) =>
		{
			assert.ok(device.hasCapability(name), 'must not write missing capabilities');
			values[name] = value;
		},
		registerCapabilityListener: () => {},
		setAvailable: async () => {},
		ensureOptionalCapability: async () => hasLineCrossed,
		triggerMotionEvent: async (name, value) => motionEvents.push([name, value]),
		error: (error) => errors.push(error),
		log: () => {}
	});
	device.err = device.error;

	return { device, values, timers, errors, motionEvents, getFlowTriggers: () => flowTriggers };
}

async function runTests()
{
	const startup = createDevice();
	await startup.device.onInit();
	assert.strictEqual(startup.values.alarm_line_crossed, false, 'startup must clear a persisted crossing alarm');
	assert.strictEqual(startup.values.alarm_motion, false);
	await startup.device.triggerLineCrossedEvent('first');
	assert.strictEqual(startup.values.alarm_line_crossed, true);
	assert.strictEqual(startup.getFlowTriggers(), 1, 'crossings must work after restart');
	const timerId = startup.device.lineCrossedTimeoutId;
	const timer = startup.timers.get(timerId);
	assert.strictEqual(timer.delay, 15000, 'preserve the existing alarm duration');
	await startup.device.triggerLineCrossedEvent('duplicate');
	assert.strictEqual(startup.getFlowTriggers(), 1, 'suppress duplicate crossings while active');
	assert.strictEqual(startup.device.lineCrossedTimeoutId, timerId);
	startup.timers.delete(timerId);
	timer.callback();
	assert.strictEqual(startup.values.alarm_line_crossed, false);
	await startup.device.triggerLineCrossedEvent('second');
	assert.strictEqual(startup.getFlowTriggers(), 2);
	assert.deepStrictEqual(startup.motionEvents, [
		['Line Crossed', true], ['Line Crossed', false], ['Line Crossed', true]
	]);

	const cleanup = createDevice();
	cleanup.values.alarm_line_crossed = false;
	await cleanup.device.triggerLineCrossedEvent('before reconnect');
	const cancelledTimer = cleanup.device.lineCrossedTimeoutId;
	cleanup.device.clearTimers();
	assert.strictEqual(cleanup.timers.has(cancelledTimer), false);
	assert.strictEqual(cleanup.device.lineCrossedTimeoutId, null);
	assert.strictEqual(cleanup.values.alarm_line_crossed, false, 'timer cleanup must not leave the alarm stuck');
	await cleanup.device.triggerLineCrossedEvent('after reconnect');
	assert.strictEqual(cleanup.getFlowTriggers(), 2, 'crossings must work after timer cleanup');

	const orphan = createDevice();
	orphan.device.clearTimers();
	assert.strictEqual(orphan.values.alarm_line_crossed, false, 'cleanup must recover an alarm with no timer');

	const missing = createDevice(false);
	await missing.device.onInit();
	missing.device.clearTimers();
	assert.strictEqual(missing.device.hasCapability('alarm_line_crossed'), false);

	const deleting = createDevice();
	deleting.device.isDeleting = true;
	deleting.device.lineCrossedTimeoutId = deleting.device.homey.setTimeout(() => {}, 15000);
	deleting.device.clearTimers();
	assert.strictEqual(deleting.timers.size, 0);
	assert.strictEqual(deleting.values.alarm_line_crossed, true, 'do not write capabilities during deletion');

	const failedReset = createDevice();
	const failure = new Error('Capability update failed');
	failedReset.device.setCapabilityValue = async () => { throw failure; };
	failedReset.device.clearTimers();
	await Promise.resolve();
	assert.deepStrictEqual(failedReset.errors, [failure], 'reset failures must be reported');

	assert.deepStrictEqual(startup.errors, []);
	assert.deepStrictEqual(cleanup.errors, []);
	assert.deepStrictEqual(missing.errors, []);
	console.log('line-crossing tests passed');
}

runTests().catch((err) =>
{
	console.error(err);
	process.exit(1);
});
