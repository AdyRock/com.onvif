# ONVIF Camera

# Support for ONVIF compatible IP cameras.
ONVIF is an industry standard supported by many cameras from a range of manufactures.
See https://www.onvif.org/ for more information about the standard.
There a various protocols defined and each camera model will support various combinations of these.
A camera requires profile S and T support for this app.

## The app has the following features:
* Current snapshot.

## Plus, if the camera supports motion detection:
* Motion alert with flow trigger,
* Motion snapshot.
* Delay between motion detection and snapshot.
* Single or multiple alerts while motion triggered.
* Enable / disable motion detection.


Motion alerts are available when supported by the camera. These can trigger a flow card.
Note: Some cameras report they have motion alerts but don't seem to generate any positive triggers.
The motion detection can be enabled / disabled in the device tile and by a flow action card.

A snapshot image is captured when a motion alert is generated and can be viewed in the device as well as a 'live' snapshot image.
Those images can be accessed by flow tags to be sent to other devices by action cards.

To add a camera, use the add device option in the Homey app, select the ONVIF app and follow the prompts.
The app uses the ONVIF discovery protocol to detect compatible cameras on you network.
The cameras have to be on the same subnet as Homey. Therefore you will have to configure the cameras as directed by the manufacturer first.

Once you have chosen a camera from the discovered list and hit next you will be asked for the user name and password required to access the camera.
Touch 'Log In' and if the details are OK the device will be added to the Home section.

Only one camera can be selected at a time when adding but you can uses the add device option again to add other cameras.

This app uses the standard ONVIF library available on npm.

