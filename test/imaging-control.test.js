'use strict';

const assert = require('assert');
const { Cam } = require('../lib/onvif');
const {
	assertBoundaryOffsetSupported,
	assertIrCutFilterModeSupported,
	assertResponseTimeSupported,
	parseImagingSupport,
	secondsToDuration
} = require('../drivers/camera/imaging-control');

function captureImagingRequest(options)
{
	const cam = Object.create(Cam.prototype);
	let request = null;
	cam.activeSource = { sourceToken: 'source-1' };
	cam._envelopeHeader = () => '<Header>';
	cam._envelopeFooter = () => '</Footer>';
	cam._request = (data) =>
	{
		request = data;
	};
	cam.setImagingSettings(options);
	return request;
}

function runTests()
{
	const options = {
		irCutFilterModes: ['AUTO', 'ON', 'OFF'],
		extension: {
			extension: {
				irCutFilterAutoAdjustment: {
					boundaryType: ['Common', 'ToOff'],
					boundaryOffset: true,
					responseTimeRange: {
						min: 'PT0.5S',
						max: 'PT1M30S'
					}
				}
			}
		}
	};
	const support = parseImagingSupport(options);
	assert.deepStrictEqual(support, {
		irCutFilterModes: ['AUTO', 'ON', 'OFF'],
		autoBoundaryTypes: ['Common', 'ToOff'],
		autoBoundaryOffset: true,
		autoResponseTimeMin: 0.5,
		autoResponseTimeMax: 90
	});
	assertIrCutFilterModeSupported(support, 'AUTO');
	assertBoundaryOffsetSupported(support, 'ToOff', 0);
	assertResponseTimeSupported(support, 'Common', 30);
	assert.strictEqual(secondsToDuration(2.5), 'PT2.5S');
	assert.throws(() => assertIrCutFilterModeSupported(support, 'MANUAL'), /not supported/);
	assert.throws(() => assertBoundaryOffsetSupported(support, 'ToOn', 0), /not supported/);
	assert.throws(() => assertResponseTimeSupported(support, 'Common', 100), /between/);

	const modeRequest = captureImagingRequest({ irCutFilter: 'OFF' });
	assert.ok(/<IrCutFilter[^>]*>OFF<\/IrCutFilter>/.test(modeRequest.body));

	const autoRequest = captureImagingRequest({
		irCutFilterAutoAdjustment: {
			boundaryType: 'ToOff',
			boundaryOffset: 0,
			responseTime: 'PT2.5S'
		}
	});
	assert.ok(/<BoundaryType[^>]*>ToOff<\/BoundaryType>/.test(autoRequest.body));
	assert.ok(/<BoundaryOffset[^>]*>0<\/BoundaryOffset>/.test(autoRequest.body));
	assert.ok(/<ResponseTime[^>]*>PT2.5S<\/ResponseTime>/.test(autoRequest.body));

	console.log('imaging-control tests passed');
}

runTests();
