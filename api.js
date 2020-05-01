const Homey = require( 'homey' );

module.exports = [

    {
        method: 'GET',
        path: '/',
        public: true,
        fn: async function( args, callback )
        {
            console.log("GET Event received: ", args);

            const result = "OK";
            if ( result instanceof Error ) return callback( result );
            return callback( null, result );

            // access /?foo=bar as args.query.foo
        }
    },

    {
        method: 'POST',
        path: '/',
        public: true,
        fn: function( args, callback )
        {
            console.log("POST Event received: ", args);

            if (args.query['deviceId'])
            {
                const driver = Homey.ManagerDrivers.getDriver( 'camera' );
                if ( driver )
                {
                    let devices = driver.getDevices();
                    for ( var i = 0; i < devices.length; i++ )
                    {
                        var device = devices[ i ];
                        if ( device.getData().id == args.query.deviceId )
                        {
                            Homey.app.updateLog( "Push Event found Device: " + args.query.deviceId );
                            device.triggerPushEvent("IsMotion", true);
                            break;
                        }
                    }
                }
    
            }

            const result = 'OK'
            if ( result instanceof Error ) return callback( result );
            return callback( null, result );
        }
    },

    {
        method: 'PUT',
        path: '/',
        public: true,
        fn: function( args, callback )
        {
            console.log("PUT Event received: ", args);

            const result = "OK"
            if ( result instanceof Error ) return callback( result );
            return callback( null, result );
        }
    },

    {
        method: 'DELETE',
        path: '/',
        public: true,
        fn: function( args, callback )
        {
            console.log("DELETE Event received: ", args);

            const result = "OK"
            if ( result instanceof Error ) return callback( result );
            return callback( null, result );
        }
    }

]