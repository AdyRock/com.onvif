'use strict';

const assert = require('assert');
const {
	EVENT_METRIC_HANDLERS,
	createEventCompareHandlers,
	createEventSpecialHandlers
} = require('../drivers/camera/event-routing');

async function runTests()
{
	// Metric handler table checks
	assert.ok(EVENT_METRIC_HANDLERS['Monitoring/ProcessorUsage:Value']);
	assert.ok(EVENT_METRIC_HANDLERS['Device/HardwareFailure/StorageFailure:Failed']);
	assert.ok(EVENT_METRIC_HANDLERS['AudioAnalytics/Audio/DetectedSound:IsSoundDetected']);
	assert.strictEqual(EVENT_METRIC_HANDLERS['Monitoring/ProcessorUsage:Value'].transform(0.5), 50);
	assert.strictEqual(EVENT_METRIC_HANDLERS['Monitoring/ProcessorUsage:Value'].transform(37), 37);

	// Compare handler binding checks
	const compareCalls = [];
	const compareDevice = {
		triggerVisitorEvent: async (value) => compareCalls.push(['visitor', value]),
		triggerPersonEvent: async (value) => compareCalls.push(['person', value]),
		triggerFaceEvent: async (value) => compareCalls.push(['face', value]),
		triggerVehicleEvent: async (value) => compareCalls.push(['vehicle', value]),
		triggerDogCatEvent: async (value) => compareCalls.push(['dogcat', value])
	};
	const compareHandlers = createEventCompareHandlers(compareDevice);

	await compareHandlers['RuleEngine/MyRuleDetector/Visitor:State'](true);
	await compareHandlers['RuleEngine/PeopleDetector/People:IsPeople'](false);
	await compareHandlers['RuleEngine/MyRuleDetector/FaceDetect:State'](true);
	await compareHandlers['RuleEngine/MyRuleDetector/VehicleDetect:State'](true);
	await compareHandlers['RuleEngine/MyRuleDetector/DogCatDetect:State'](false);

	assert.deepStrictEqual(compareCalls, [
		['visitor', true],
		['person', false],
		['face', true],
		['vehicle', true],
		['dogcat', false]
	]);

	// Special handler binding checks
	const specialCalls = [];
	const specialDevice = {
		routeLineCrossedEvent: (value) =>
		{
			specialCalls.push(['line', value]);
			return true;
		},
		routeDarkImageEvent: (value) =>
		{
			specialCalls.push(['dark', value]);
			return true;
		}
	};
	const specialHandlers = createEventSpecialHandlers(specialDevice);
	assert.strictEqual(specialHandlers['RuleEngine/LineDetector/Crossed:ObjectId']('abc'), true);
	assert.strictEqual(specialHandlers['VideoSource/ImageTooDark/ImagingService:State'](false), true);
	assert.deepStrictEqual(specialCalls, [
		['line', 'abc'],
		['dark', false]
	]);

	console.log('event-routing tests passed');
}

runTests().catch((err) =>
{
	console.error(err);
	process.exit(1);
});
