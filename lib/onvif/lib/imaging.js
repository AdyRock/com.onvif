/**
 * @namespace cam
 * @description Media section for Cam class
 * @author Andrew D.Laptev <a.d.laptev@gmail.com>
 * @licence MIT
 */
module.exports = function(Cam) {

	const linerase = require('./utils').linerase;

	/**
	 * @typedef {object} Cam~ImagingSettings
	 * @property {number} brightness
	 * @property {number} colorSaturation
	 * @property {object} focus
	 * @property {string} focus.autoFocusMode
	 * @property {number} sharpness
	 */

	/**
	 * @callback Cam~GetImagingSettingsCallback
	 * @property {?Error} error
	 * @property {Cam~ImagingSettings} status
	 */

	/**
	 * Get the ImagingConfiguration for the requested VideoSource (default - the activeSource)
	 * @param {object} [options]
	 * @param {string} [options.token] {@link Cam#activeSource.profileToken}
	 * @param {Cam~GetImagingSettingsCallback} callback
	 */
	Cam.prototype.getImagingSettings = function(options, callback) {
		if (typeof callback === 'undefined') {
			callback = options;
			options = {};
		}
		this._request({
			service: 'imaging'
			, body: this._envelopeHeader() +
			'<GetImagingSettings xmlns="http://www.onvif.org/ver20/imaging/wsdl" >' +
				'<VideoSourceToken  xmlns="http://www.onvif.org/ver20/imaging/wsdl" >' + ( options.token || this.activeSource.sourceToken ) + '</VideoSourceToken>' +
			'</GetImagingSettings>' +
			this._envelopeFooter()
		}, function(err, data, xml) {
			if (callback) {
				callback.call(this, err, err ? null : linerase(data).getImagingSettingsResponse.imagingSettings, xml);
			}
		}.bind(this));
	};

	/**
	 * @typedef {object} Cam~ImagingSetting
	 * @property {string} token Video source token
	 * @property {number} brightness
	 * @property {number} colorSaturation
	 * @property {number} contrast
   * @property {object} exposure
   * @property {string} exposure.mode Exposure mode -enum { 'AUTO', 'MANUAL' }
   * @property {string} exposure.priority The exposure priority mode (low noise/framerate) -enum { 'LowNoise', 'FrameRate' }
   * @property {number} exposure.minExposureTime
   * @property {number} exposure.maxExposureTime
   * @property {number} exposure.minGain
   * @property {number} exposure.maxGain
   * @property {number} exposure.minIris
   * @property {number} exposure.maxIris
   * @property {number} exposure.exposureTime
   * @property {number} exposure.gain
   * @property {number} exposure.iris
   * @property {object} focus
   * @property {string} focus.autoFocusMode Mode of auto focus -enum { 'AUTO', 'MANUAL' }
   * @property {number} focus.defaultSpeed
   * @property {number} focus.nearLimit
   * @property {number} focus.farLimit
	 * @property {number} sharpness
	 */

	/**
	 * Set the ImagingConfiguration for the requested VideoSource (default - the activeSource)
	 * @param {Cam~ImagingSetting} options
	 * @param callback
	 */
	Cam.prototype.setImagingSettings = function(options, callback) {
		this._request({
			service: 'imaging'
			, body: this._envelopeHeader() +
			'<SetImagingSettings xmlns="http://www.onvif.org/ver20/imaging/wsdl" >' +
				'<VideoSourceToken  xmlns="http://www.onvif.org/ver20/imaging/wsdl" >' +
					( options.token || this.activeSource.sourceToken) +
				'</VideoSourceToken>' +

				'<ImagingSettings xmlns="http://www.onvif.org/ver20/imaging/wsdl" >' +
					(
						options.brightness ?
							(
								'<Brightness xmlns="http://www.onvif.org/ver10/schema">' +
								options.brightness +
								'</Brightness>'
							) : ''
					)

				+

					(
						options.colorSaturation ?
							(
								'<ColorSaturation xmlns="http://www.onvif.org/ver10/schema">' +
									options.colorSaturation +
								'</ColorSaturation>'
							) : ''
					)

				+

					(
						options.contrast ?
							(
								'<Contrast xmlns="http://www.onvif.org/ver10/schema">' +
									options.contrast +
								'</Contrast>'
							) : ''
					)

				+
				(
					options.exposure ?
						(
							'<Exposure  xmlns="http://www.onvif.org/ver10/schema">' +
							(
								options.exposure.mode ?
									(
										'<Mode xmlns="http://www.onvif.org/ver10/schema">' + options.exposure.mode + '</Mode>'
									) : ''
							)

							+

							(
								options.exposure.priority ?
									(
										'<Priority xmlns="http://www.onvif.org/ver10/schema">' + options.exposure.priority + '</Priority>'
									) : ''
							)

							+

							(
								options.exposure.minExposureTime ?
									(
										'<MinExposureTime xmlns="http://www.onvif.org/ver10/schema">' + options.exposure.minExposureTime + '</MinExposureTime>'
									) : ''
							)

							+

							(
								options.exposure.maxExposureTime ?
									(
										'<MaxExposureTime xmlns="http://www.onvif.org/ver10/schema">' + options.exposure.maxExposureTime + '</MaxExposureTime>'
									) : ''
							)

							+

							(
								options.exposure.minGain ?
									(
										'<MinGain xmlns="http://www.onvif.org/ver10/schema">' + options.exposure.minGain + '</MinGain>'
									) : ''
							)

							+

							(
								options.exposure.maxGain ?
									(
										'<MaxGain xmlns="http://www.onvif.org/ver10/schema">' + options.exposure.maxGain + '</MaxGain>'
									) : ''
							)

							+

							(
								options.exposure.minIris ?
									(
										'<MinIris xmlns="http://www.onvif.org/ver10/schema">' + options.exposure.minIris + '</MinIris>'
									) : ''
							)

							+

							(
								options.exposure.maxIris ?
									(
										'<MaxIris xmlns="http://www.onvif.org/ver10/schema">' + options.exposure.maxIris + '</MaxIris>'
									) : ''
							)

							+

							(
								options.exposure.exposureTime ?
									(
										'<ExposureTime xmlns="http://www.onvif.org/ver10/schema">' + options.exposure.exposureTime + '</ExposureTime>'
									) : ''
							)

							+

							(
								options.exposure.gain ?
									(
										'<Gain xmlns="http://www.onvif.org/ver10/schema">' + options.exposure.gain + '</Gain>'
									) : ''
							)

							+

							(
								options.exposure.iris ?
									(
										'<Iris xmlns="http://www.onvif.org/ver10/schema">' + options.exposure.iris + '</Iris>'
									) : ''
							) +
							'</Exposure>'
						) : ''
				)

				+

				(
					options.focus ?
						(
							'<Focus xmlns="http://www.onvif.org/ver10/schema">' +
							(
								options.focus.autoFocusMode ?
									(
										'<AutoFocusMode xmlns="http://www.onvif.org/ver10/schema">' + options.focus.autoFocusMode + '</AutoFocusMode>'
									) : ''
							)

							+

							(
								options.focus.defaultSpeed ?
									(
										'<DefaultSpeed xmlns="http://www.onvif.org/ver10/schema">' + options.focus.defaultSpeed + '</DefaultSpeed>'
									) : ''
							)

							+
							(
								options.focus.nearLimit ?
									(
										'<NearLimit xmlns="http://www.onvif.org/ver10/schema">' + options.focus.nearLimit + '</NearLimit>'
									) : ''
							)

							+

							(
								options.focus.farLimit ?
									(
										'<FarLimit xmlns="http://www.onvif.org/ver10/schema">' + options.focus.farLimit + '</FarLimit>'
									) : ''
							) +
							'</Focus>'
						) : ''
				)

				+

					(
						options.sharpness ?
							(
								'<Sharpness xmlns="http://www.onvif.org/ver10/schema">' +
									options.sharpness +
								'</Sharpness>'
							) : ''
					)

				+
				'</ImagingSettings>' +
			'</SetImagingSettings>' +
			this._envelopeFooter()
		}, function(err, data, xml) {
			if (callback) {
				callback.call(this, err, err ? null : linerase(data).setImagingSettingsResponse, xml);
			}
		}.bind(this));
	};

	/**
	 * @typedef {object} Cam~ImagingServiceCapabilities
	 * @property {boolean} ImageStabilization Indicates whether or not Image Stabilization feature is supported
	 * @property {boolean} [Presets] Indicates whether or not Imaging Presets feature is supported
	 */

	/**
	 * @callback Cam~GetImagingServiceCapabilitiesCallback
	 * @property {?Error} error
	 * @property {Cam~ImagingServiceCapabilities} capabilities
	 */

	/**
	 * Returns the capabilities of the imaging service
	 * @property {Cam~GetImagingServiceCapabilitiesCallback}
	 */
	Cam.prototype.getImagingServiceCapabilities = function(callback) {
		this._request({
			service: 'imaging'
			, body: this._envelopeHeader() +
			'<GetServiceCapabilities xmlns="http://www.onvif.org/ver20/imaging/wsdl" >' +
			'</GetServiceCapabilities>' +
			this._envelopeFooter()
		}, function(err, data, xml) {
			if (callback) {
				callback.call(this, err, err ? null : linerase(data[0].getServiceCapabilitiesResponse[0].capabilities[0].$), xml);
			}
		}.bind(this));
	};

	/**
	 * @typedef {object} Cam~ImagingPreset
	 * @property {string} token
	 * @property {string} type Indicates Imaging Preset Type
	 * @property {string} Name Human readable name of the Imaging Preset
	 */

	/**
	 * @callback Cam~GetCurrentImagingPresetCallback
	 * @property {?Error} error
	 * @property {Cam~ImagingPreset} preset
	 */

	/**
	 * Get the last Imaging Preset applied
	 * @param {object} [options]
	 * @param {string} [options.token] Reference token to the VideoSource where the current Imaging Preset should be requested
	 * @param {Cam~GetCurrentImagingPresetCallback} callback
	 */
	Cam.prototype.getCurrentImagingPreset = function(options, callback) {
		if (typeof callback === 'undefined') {
			callback = options;
			options = {};
		}
		this._request({
			service: 'imaging'
			, body: this._envelopeHeader() +
			'<GetCurrentPreset xmlns="http://www.onvif.org/ver20/imaging/wsdl" >' +
				'<VideoSourceToken>' + ( options.token || this.activeSource.sourceToken ) + '</VideoSourceToken>' +
			'</GetCurrentPreset>' +
			this._envelopeFooter()
		}, function(err, data, xml) {
			if (callback) {
				callback.call(this, err, err ? null : linerase(data).getCurrentPresetResponse.preset, xml);
			}
		}.bind(this));
	};

	/**
	 * Set the ImagingConfiguration for the requested or current VideoSource
	 * @param options
	 * @param {string} [options.token] Reference token to the VideoSource to which the specified Imaging Preset should be applied.
	 * @param {string} options.presetToken Reference token to the Imaging Preset to be applied to the specified Video Source
	 * @param {Cam~RequestCallback} callback
	 */
	Cam.prototype.setCurrentImagingPreset = function(options, callback) {
		this._request({
			service: 'imaging'
			, body: this._envelopeHeader() +
			'<SetCurrentPreset xmlns="http://www.onvif.org/ver20/imaging/wsdl" >' +
				'<VideoSourceToken>' + ( options.token || this.activeSource.sourceToken ) + '</VideoSourceToken>' +
				'<PresetToken>' + options.presetToken + '</PresetToken>' +
			'</SetCurrentPreset>' +
			this._envelopeFooter()
		}, function(err, data, xml) {
			if (callback) {
				callback.call(this, err, err ? null : linerase(data).setCurrentPresetResponse, xml);
			}
		}.bind(this));
	};

	/**
	 * Get the video source options for a given video source
	 * @param {Object} options.token videoSourceToken 
	 * @param {function} [callback]
	 */
	Cam.prototype.getVideoSourceOptions = function(options, callback) {
		if (typeof callback === 'undefined') {
			callback = options;
			options = {};
		}
		this._request({
			service: 'imaging'
			, body: this._envelopeHeader() +
				'<GetOptions xmlns="http://www.onvif.org/ver20/imaging/wsdl">' +
				'<VideoSourceToken>' + (options.token || this.activeSource.sourceToken) + '</VideoSourceToken>' +
				'</GetOptions>' +
				this._envelopeFooter()
		}, function(err, data, xml) {
			if (callback) {
				let jsonData = linerase(data),
					respData = {};
				if (jsonData && jsonData.getOptionsResponse && jsonData.getOptionsResponse.imagingOptions) {
					respData = jsonData.getOptionsResponse.imagingOptions;
				}
				// Empty response on success
				callback.call(this, err, respData, xml);
			}
		}.bind(this));
	};
};
