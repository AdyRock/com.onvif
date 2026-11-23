'use strict';

function asArray(value)
{
	if (value === undefined || value === null)
	{
		return [];
	}

	return Array.isArray(value) ? value : [value];
}

function findProperty(value, propertyName)
{
	if (!value || typeof value !== 'object')
	{
		return undefined;
	}

	const key = Object.keys(value).find((candidate) => candidate.toLowerCase() === propertyName.toLowerCase());
	if (key)
	{
		return value[key];
	}

	for (const child of Object.values(value))
	{
		if (child && typeof child === 'object')
		{
			const result = findProperty(child, propertyName);
			if (result !== undefined)
			{
				return result;
			}
		}
	}

	return undefined;
}

function parseDurationSeconds(value)
{
	if (typeof value !== 'string')
	{
		return null;
	}

	const match = /^P(?:(\d+(?:\.\d+)?)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(value);
	if (!match)
	{
		return null;
	}

	const days = Number(match[1] || 0);
	const hours = Number(match[2] || 0);
	const minutes = Number(match[3] || 0);
	const seconds = Number(match[4] || 0);
	return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function parseImagingSupport(options = {})
{
	const autoAdjustment = findProperty(options, 'irCutFilterAutoAdjustment');
	const responseRange = autoAdjustment && findProperty(autoAdjustment, 'responseTimeRange');
	return {
		irCutFilterModes: asArray(findProperty(options, 'irCutFilterModes')).map(String),
		autoBoundaryTypes: autoAdjustment
			? asArray(findProperty(autoAdjustment, 'boundaryType')).map(String)
			: [],
		autoBoundaryOffset: Boolean(autoAdjustment && findProperty(autoAdjustment, 'boundaryOffset')),
		autoResponseTimeMin: responseRange ? parseDurationSeconds(findProperty(responseRange, 'min')) : null,
		autoResponseTimeMax: responseRange ? parseDurationSeconds(findProperty(responseRange, 'max')) : null
	};
}

function assertIrCutFilterModeSupported(support, mode)
{
	if (!support || !support.irCutFilterModes.includes(mode))
	{
		throw new Error('IR cut filter mode ' + mode + ' is not supported by this camera.');
	}
}

function assertAutoBoundaryTypeSupported(support, boundaryType)
{
	if (!support || !support.autoBoundaryTypes.includes(boundaryType))
	{
		throw new Error('IR cut filter auto boundary ' + boundaryType + ' is not supported by this camera.');
	}
}

function assertBoundaryOffsetSupported(support, boundaryType, offset)
{
	assertAutoBoundaryTypeSupported(support, boundaryType);
	if (!support.autoBoundaryOffset)
	{
		throw new Error('IR cut filter auto boundary offset is not supported by this camera.');
	}
	if (!Number.isFinite(offset) || offset < -1 || offset > 1)
	{
		throw new Error('IR cut filter auto boundary offset must be between -1 and 1.');
	}
}

function assertResponseTimeSupported(support, boundaryType, responseTime)
{
	assertAutoBoundaryTypeSupported(support, boundaryType);
	if (support.autoResponseTimeMin === null || support.autoResponseTimeMax === null)
	{
		throw new Error('IR cut filter auto response time is not supported by this camera.');
	}
	if (!Number.isFinite(responseTime) || responseTime < support.autoResponseTimeMin || responseTime > support.autoResponseTimeMax)
	{
		throw new Error('IR cut filter auto response time must be between ' + support.autoResponseTimeMin + ' and ' + support.autoResponseTimeMax + ' seconds.');
	}
}

function secondsToDuration(seconds)
{
	const normalizedSeconds = Number(seconds);
	return 'PT' + normalizedSeconds + 'S';
}

module.exports = {
	assertBoundaryOffsetSupported,
	assertIrCutFilterModeSupported,
	assertResponseTimeSupported,
	parseImagingSupport,
	secondsToDuration
};
