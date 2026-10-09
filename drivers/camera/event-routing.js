'use strict';

const EVENT_SOURCE_TOKEN_NAMES = ['Source', 'VideoSourceConfigurationToken'];

const EVENT_METRIC_HANDLERS = {
	'Monitoring/ProcessorUsage:Value': {
		optionalCapability: 'cpu',
		capability: 'measure_cpu',
		transform: (value) => (value <= 1 ? (value * 100) : value)
	},
	'Device/HardwareFailure/StorageFailure:Failed': {
		optionalCapability: 'storage',
		capability: 'alarm_storage'
	},
	'AudioAnalytics/Audio/DetectedSound:IsSoundDetected': {
		optionalCapability: 'sound',
		capability: 'alarm_sound'
	}
};

function createEventCompareHandlers(device)
{
	return {
		'RuleEngine/MyRuleDetector/Visitor:State': device.triggerVisitorEvent.bind(device),
		'RuleEngine/MyRuleDetector/PeopleDetect:State': device.triggerPersonEvent.bind(device),
		'RuleEngine/PeopleDetector/People:IsPeople': device.triggerPersonEvent.bind(device),
		'RuleEngine/MyRuleDetector/FaceDetect:State': device.triggerFaceEvent.bind(device),
		'RuleEngine/MyRuleDetector/VehicleDetect:State': device.triggerVehicleEvent.bind(device),
		'RuleEngine/MyRuleDetector/DogCatDetect:State': device.triggerDogCatEvent.bind(device)
	};
}

function createEventSpecialHandlers(device)
{
	return {
		'RuleEngine/LineDetector/Crossed:ObjectId': device.routeLineCrossedEvent.bind(device),
		'RuleEngine/LineDetector/Crossed:State': device.routeLineCrossedStateEvent.bind(device),
		'VideoSource/ImageTooDark/ImagingService:State': device.routeDarkImageEvent.bind(device)
	};
}

function getEventSourceTokens(eventSource)
{
	const sourceItems = Array.isArray(eventSource) ? eventSource : [eventSource];

	return sourceItems
		.filter((sourceItem) => sourceItem?.$ && EVENT_SOURCE_TOKEN_NAMES.indexOf(sourceItem.$.Name) >= 0)
		.map((sourceItem) => sourceItem.$.Value);
}

function eventMatchesActiveSource(eventSource, configuredToken, activeSource)
{
	if (!configuredToken)
	{
		return true;
	}

	const eventTokens = getEventSourceTokens(eventSource);
	if (eventTokens.length === 0)
	{
		return true;
	}

	const activeTokens = [
		configuredToken,
		activeSource?.sourceToken,
		activeSource?.videoSourceConfigurationToken
	].filter(Boolean);

	return eventTokens.some((eventToken) => activeTokens.indexOf(eventToken) >= 0);
}

module.exports = {
	EVENT_METRIC_HANDLERS,
	createEventCompareHandlers,
	createEventSpecialHandlers,
	eventMatchesActiveSource,
	getEventSourceTokens
};
