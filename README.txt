This app only supports cameras that comply with the ONVIF S and T profiles but that includes devices from hundred of different brands.
If the camera is compatible it should be detected during Add new device procedure provided it is on the same network segment.
The cameras can even be on a sub-network, provided the sub-nets are routable, but you will need to manually enter the IP address.

If the cameras are connected to a compatible NVR then the NVR will be detected initially but when you add the NVR you will then be shown each camera to add.

You can view the current snapshot image if the camera can provide a JPG image via a URL.

Plus, if the camera supports a compatible motion detection method, you can:
* Get a motion alert with a flow trigger,
* Get a motion snapshot image if the camera supports a JPG image.
* Set the delay between motion detection and snapshot.
* Enable single or multiple alerts while motion is triggered.
* You can also enable and disable Homey motion detection via the device tile or flow cards.

An image is captured when a motion alert is generated and can be viewed in the device tile as well as a 'live' snapshot image that is refreshed at will.
Those images can also be accessed by flow tags to be sent to other devices by action cards.
