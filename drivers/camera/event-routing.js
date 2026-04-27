'use strict';

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
		'VideoSource/ImageTooDark/ImagingService:State': device.routeDarkImageEvent.bind(device)
	};
}

module.exports = {
	EVENT_METRIC_HANDLERS,
	createEventCompareHandlers,
	createEventSpecialHandlers
};
