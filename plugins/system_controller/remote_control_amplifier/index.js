'use strict';

// I used supercrab's gpio_control plugin as a basis for this project
//https://www.nodenpm.com/lirc-client/package.html
var libQ = require("kew");
var fs = require("fs-extra");
const lirc = require('lirc-client')({
    path: '/var/run/lirc/lircd'
});
var config = new (require("v-conf"))();

var io = require('socket.io-client');
var socket = io.connect("http://localhost:3000");
var execSync = require('child_process').execSync;

// Event string consts
const SYSTEM_STARTUP = "systemStartup";
const SYSTEM_SHUTDOWN = "systemShutdown";
const MUSIC_PLAY = "musicPlay";
const MUSIC_PAUSE = "musicPause";
const MUSIC_STOP = "musicStop";
const VOLUME_CHANGE = "SetAlsaVolume";

// IR device related settings - these are only defaults, subject to change from loading config 
var devicename = 'receiver';
var start_button = 'KEY_POWER';
var stop_button = 'KEY_POWER2';
var vol_down_button = 'KEY_VOLUMEDOWN';
var vol_up_button = 'KEY_VOLUMEUP';

// behavior related settings - 
var stopToTurnOffDelay = 60;
var keypressTimeOut = 100;

// Events that we can detect and do something
const events = [SYSTEM_STARTUP, SYSTEM_SHUTDOWN, MUSIC_PLAY, MUSIC_PAUSE, MUSIC_STOP, VOLUME_CHANGE];

module.exports = IRControl;


// Constructor
// on the constructor, this needs to be heavily changed to initializa all the IR specific stuff 
function IRControl(context) {
    var self = this;
    self.context = context;
    self.commandRouter = self.context.coreCommand;
    self.logger = self.context.logger;
    self.load18nStrings();
    self.piBoard = self.getPiBoardInfo();
    self.stopRequested = false;
    self.stopInProgress = false;
    // assume that the amplifier has been turned off
    self.log('Initializing IRControl');
	self.amplifierOn = false;
	self.savedDesiredConfig = {"volume": 0};
}

// Volumio is starting
// read the states from the config file 
IRControl.prototype.onVolumioStart = function () {
    var self = this;
    self.log('onVolumioStart');
    var configFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, "config.json");
    config.loadFile(configFile);
    this.savedDesiredConfig.volume = config.data.volume;
    this.amplifierOn = false; 
    self.log(`Detected ${self.piBoard.name}`);
    self.log(`40 GPIOs: ${self.piBoard.fullGPIO}`);
    self.log("Initialized");

    return libQ.resolve();
}

// Volumio is shutting down
// todo - on volumio shutdown let's save the state and compare with what does mpd says about it (volume for example)
// on stopping volumio, we may need to set the amplifier to play back radio or something (not sure yet)
IRControl.prototype.onVolumioShutdown = function () {
    var self = this;
    socket.emit("getState", "");
    socket.on("pushState", function (state) {
        self.handleEvent(SYSTEM_SHUTDOWN, state);
    })
    return libQ.resolve();
};

// Return config filename
IRControl.prototype.getConfigurationFiles = function () {
    return ["config.json"];
}

// Plugin has started
IRControl.prototype.onStart = function () {
    var self = this;
    var defer = libQ.defer();

    // read and parse status once
    socket.emit("getState", "");
    socket.once("pushState", self.statusChanged.bind(self));
    this.log('onStart was called')
    // listen to every subsequent status report from Volumio
    // status is pushed after every playback action, so we will be
    // notified if the status changes
    socket.on("pushState", self.statusChanged.bind(self));

    // Create pin objects
    // todo chek if everything is alright with the lirc sender
    self.recreateState()
        .then(function (result) {
            self.log("State created from configuration created");
            state
            self.handleEvent(SYSTEM_STARTUP);
            defer.resolve();
        });

    return defer.promise;
};

// Pluging has stopped
IRControl.prototype.onStop = function () {
    //todo let's save all the states of volumio to the config file
    var self = this;
    var defer = libQ.defer();

    self.saveStatesToFile()
        .then(function (result) {
            self.log("State was saved to config file ");
            defer.resolve();
        });

    return libQ.resolve();
};

// The usual plugin guff :p

IRControl.prototype.onRestart = function () {
    var self = this;
};

IRControl.prototype.onInstall = function () {
    var self = this;
};

IRControl.prototype.onUninstall = function () {
    var self = this;
};

IRControl.prototype.getConf = function (varName) {
    var self = this;
};

IRControl.prototype.setConf = function (varName, varValue) {
    var self = this;
};

IRControl.prototype.getAdditionalConf = function (type, controller, data) {
    var self = this;
};

IRControl.prototype.setAdditionalConf = function () {
    var self = this;
};

IRControl.prototype.setUIConfig = function (data) {
    var self = this;
};

// Read config from UI
IRControl.prototype.getUIConfig = function () {
    var defer = libQ.defer();
    var self = this;
    var lang_code = self.commandRouter.sharedVars.get("language_code");
    var UIConfigFile;

    // Depending on our pi version change the number of pins available in GUI
    // todo UIConfig.json will need to be changed according to the amplifier's stuff
    if (self.piBoard.fullGPIO)
        UIConfigFile = __dirname + "/UIConfig.json";
    else
        UIConfigFile = __dirname + "/UIConfig-OldSchool.json";

    self.log(`UI Config file ${UIConfigFile}`);

	// add Hungarian 
	self.commandRouter.i18nJson(
		__dirname + "/i18n/strings_" + lang_code + ".json",
		__dirname + "/i18n/strings_en.json",
		UIConfigFile
	)
		.then(function(uiconf)
		{
			//var i = 0;
			//todo this is not needed. We need to get the last volume, to configure it
			events.forEach(function(e) {

                // Strings for data fields
                var s1 = e.concat("Enabled");
                var s2 = e.concat("Pin");
                var s3 = e.concat("State");

                // Strings for config
                var c1 = e.concat(".enabled");
                var c2 = e.concat(".pin");
                var c3 = e.concat(".state");

                // Extend the find method on the content array - mental but works
                uiconf.sections[0].content.findItem = function (obj) {
                    return this.find(function (item) {
                        for (var prop in obj)
                            if (!(prop in item) || obj[prop] !== item[prop])
                                return false;
                        return true;
                    });
                }

                // Populate our controls
                self.setSwitchElement(uiconf, s1, config.get(c1));
                self.setSelectElementStr(uiconf, s2, config.get(c2));
                self.setSelectElement(uiconf, s3, config.get(c3), self.boolToString(config.get(c3)));
            });

            defer.resolve(uiconf);
        })
        .fail(function () {
            defer.reject(new Error('Failed to load configuration'));
        });

    return defer.promise;
};

// Save config
IRControl.prototype.saveConfig = function (data) {
    // when we save the config, we need to save the volume state of MPD
    var self = this;

	self.log("Saving config");
	config.set('volume',this.savedDesiredConfig.volume)
    config.set('amplifierOn',this.amplifierOn)

    self.commandRouter.pushToastMessage('success', self.getI18nString("PLUGIN_CONFIGURATION"), self.getI18nString("SETTINGS_SAVED"));
};

IRControl.prototype.saveDesiredState = function (data) {
    // not yet used
    var self = this;
    this.savedDesiredConfig.set("volume", data.volume)
    this.savedDesiredConfig.set("on", data.on)
    return libQ.resolve();
};


IRControl.prototype.setVolume = async function (newvolume) {
    var self = this;
    var currentvolume = this.savedDesiredConfig.volume

    if (newvolume < currentvolume) {
        self.log("Decreasing volume from " + currentvolume + " to " + newvolume)
        for (var i = 0; i < currentvolume - newvolume; i++) {
			self.decreaseVolume();
			self.log('Waiting for '+String(keypressTimeOut));
            await new Promise(resolve => setTimeout(resolve, keypressTimeOut));
        }
    }
    if (newvolume > currentvolume) {
        self.log("Increasing volume from " + currentvolume + " to " + newvolume)
        for (var i = 0; i < newvolume - currentvolume; i++) {
			self.increaseVolume();
			self.log('Waiting for '+String(keypressTimeOut));
            await new Promise(resolve => setTimeout(resolve, keypressTimeOut));
        }
    }
    this.savedDesiredConfig = {"volume": newvolume}
}

IRControl.prototype.increaseVolume = function () {
    lirc.sendOnce(devicename, vol_up_button).catch(error => {
		if (error) this.log(error);
		self.log('Increased volume by a bit');
	});
}

IRControl.prototype.decreaseVolume = function () {

    lirc.sendOnce(devicename, vol_down_button).catch(error => {
		if (error) this.log(error);
		self.log('Decreased volume by a bit');
	});
	
}

IRControl.prototype.turnItOff = function () {
    lirc.sendOnce(devicename, stop_button).catch(error => {
		this.log('Sending:'+stop_button);
		if (error) this.log(error);
    });
}

IRControl.prototype.turnItOn = function () {
    lirc.sendOnce(devicename, start_button).catch(error => {
		this.log('Sending:'+start_button);
		if (error) this.log(error);
    });
}


IRControl.prototype.turnOffAmplifierWithDelay = async function () {
    var self = this;
    if (!self.stopInProgress) {
        self.log('Playback was stopped, amplifier will be turned off in ' + stopToTurnOffDelay + ' seconds')
        self.stopInProgress = true;
        self.stopRequested = true;
        return new Promise(function (resolve, reject) {
            setTimeout(() => {
                self.log('Stopping the amplifier')
                if (self.stopRequested === true) {
                    self.turnItOff();
                    self.log('Amplifier was turned off')
                    self.amplifierOn = false;
                    self.stopInProgress = false;
                    self.stopRequested = false;
                    resolve();
                } else {
					self.log('Stopping was cancelled');
					self.stopRequested = false;
                    self.stopInProgress = false;
                }
            }, stopToTurnOffDelay * 1000)
        })
    }
}

IRControl.prototype.turnOnAmplifier = function () {
    // if there is a counter already started to stop the amplifier, stop this and press the power button (anyway it doesn't hurt)
    var self = this;
    self.stopInProgress = false;
    self.stopRequested = false;
    if (self.amplifierOn === false) {
        self.log('Playback started - turning the amplifier on ')
        self.turnItOn();
        self.amplifierOn = true;
    }
}

IRControl.prototype.compareStates = function (data) {
    var self = this;
    if (self.desiredconfig.volume != data.volume) {
        self.log("Need to increase volume to " + data.volume)
        self.setVolume(data.volume)
    }
}


// Create ir objects for future events
// todo this function needs to be replaced with ir specific stuff 
IRControl.prototype.recreateState = function() {
	var self = this;
	self.log("Reading config and setting volumes");
	self.log("recreateState was called")
	var configFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, "config.json");
	config.loadFile(configFile);
	this.savedDesiredConfig.volume=config.volume;
	return libQ.resolve();
};

// Release our ircontrol objects
// todo not sure that this is necessary in our case 
IRControl.prototype.saveStatesToFile = function () {
    var self = this;

    self.log("saveStatesToFile was called")
    config.set("volume", this.savedDesiredConfig.volume)
    config.set("amplifierOn", this.amplifierOn)
    config.save();

	return libQ.resolve();
};

// Playing status has changed
// (might not always be a play or pause action)
IRControl.prototype.statusChanged = function (state) {
    var self = this;
    self.log('State is like ' + String(state.status));
    if (state.status == "play")
        self.handleEvent(MUSIC_PLAY, state);
    else if (state.status == "pause")
        self.handleEvent(MUSIC_PAUSE, state);
    else if (state.status == "stop")
        self.handleEvent(MUSIC_STOP, state);
}

// An event has happened so do something about it
// handleevent needs to look at the event and check all the stuff that mpd has to offer 
IRControl.prototype.handleEvent = function(e,state= {"volume":1}) {
	var self = this;
	self.log('handleEvent was called for '+e)
	self.log('handleEvent volume state is like:'+state.volume);
	this.saveDesiredState = {"volume":state.volume};
	self.setVolume(state.volume);
	if (e == MUSIC_PAUSE){
		self.turnOffAmplifierWithDelay();
	}
	if (e == MUSIC_STOP){
		self.turnOffAmplifierWithDelay();
	}
	if (e == MUSIC_PLAY){
		self.turnOnAmplifier();
	}
	if (e == SYSTEM_SHUTDOWN){
		self.saveConfig()
		self.tu
		// handle system shutdown
	}
	if (e == SYSTEM_STARTUP){
        self.amplifierOn = false;
		// handle system startup
	}
}

// Output to log
IRControl.prototype.log = function (s) {
    var self = this;
    self.logger.info("[amplifier_remote_Control] " + s);
}

// Function for printing booleans
IRControl.prototype.boolToString = function (value) {
    var self = this;
    return value ? self.getI18nString("ON") : self.getI18nString("OFF");
}

// A method to get some language strings used by the plugin
IRControl.prototype.load18nStrings = function () {
    var self = this;

    try {
        var language_code = this.commandRouter.sharedVars.get('language_code');
        self.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_' + language_code + ".json");
    } catch (e) {
        self.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
    }

    self.i18nStringsDefaults = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
};

// Retrieve a string
IRControl.prototype.getI18nString = function (key) {
    var self = this;

    if (self.i18nStrings[key] !== undefined)
        return self.i18nStrings[key];
    else
        return self.i18nStringsDefaults[key];
};

// Retrieve a UI element from UI config
IRControl.prototype.getUIElement = function (obj, field) {
    var self = this;
    self.log('getUIElement was called')
    var lookfor = JSON.parse('{"id":"' + field + '"}');
    return obj.sections[0].content.findItem(lookfor);
}

// Populate switch UI element
IRControl.prototype.setSwitchElement = function (obj, field, value) {
    var self = this;
    self.log('setSwitchElement was called')
    var result = self.getUIElement(obj, field);
    if (result)
        result.value = value;
}

// Populate select UI element
IRControl.prototype.setSelectElement = function (obj, field, value, label) {
    var self = this;
    self.log('setSelectElement was called')
    var result = self.getUIElement(obj, field);
    if (result) {
        result.value.value = value;
        result.value.label = label;
    }
}

// Populate select UI element when value matches the label
IRControl.prototype.setSelectElementStr = function (obj, field, value) {
    var self = this;
    self.setSelectElement(obj, field, value, value.toString());
}

// Retrieves information about the Pi hardware
// Ignores the compute module for now
// todo actually we need to check the status of the infrared devices 
IRControl.prototype.getPiBoardInfo = function () {
    var self = this;
    var regex = "(?:Pi)" +
        "(?:\\s(\\d+))?" +
        "(?:\\s(Zero)(?:\\s(W))?)?" +
        "(?:\\sModel\\s(?:([AB])(?:\\s(Plus))?))?" +
        "(?:\\sRev\\s(\\d+)(?:\\.(\\d+))?)?";
    var re = new RegExp(regex, "gi"); // global and case insensitive
    var boardName = self.getPiBoard(); // Returns Pi 1 as a defualt
    var groups = re.exec(boardName);
    var pi = new Object();
    ;

    // Regex groups
    // ============
    // 0 - Full text matched
    // 1 - Board number: 0, 1, 2, 3
    // 2 - Zero: Zero
    // 3 - Zero W: W
    // 4 - Model: A, B
    // 5 - Model plus: +
    // 6 - PCB major revision: int
    // 7 - PCB minor revision: int
    self.log('getPiBoardInfo loaded')
    // Have we found a valid Pi match
    if (groups[0]) {
        pi.name = boardName; // Full board name
        pi.isZero = groups[2] == "Zero" // null, Zero
        pi.isZeroW = groups[3] == "W"; // null, W
        pi.model = groups[4]; // null, A, B
        pi.isModelPlus = groups[5] == "Plus"; // null, plus
        pi.revisionMajor = groups[6]; // null, digit
        pi.revisionMinor = groups[7]; // null, digit
        pi.boardNumber = 1; // Set to Pi 1 (default - not model number found)

        if (pi.isZero) // We found a Pi Zero
            pi.boardNumber = 0;
        else if (groups[1])	// We have Pi with a model number; i.e. 2, 3
            pi.boardNumber = Number(groups[1].trim());

        // Do we have 40 GPIOs or not?
        //if ((pi.boardNumber == 1)  && !pi.isModelPlus)
        //	pi.fullGPIO = false;
        //else
        //	pi.fullGPIO = true;
    } else {
        // This should never happen
        pi.name = "Unknown";
        //pi.fullGPIO = false;
    }

    // Return pi object
    return pi;
}

// Try to get the hardware board we're running on currently (default is Pi 1)
// Pi names
//
// https://elinux.org/RPi_HardwareHistory
// Raspberry Pi Zero Rev1.3, Raspberry Pi Model B Rev 1, Raspberry Pi 2 Model B Rev 1.0
IRControl.prototype.getPiBoard = function () {
    var self = this;
    var board;
    self.log('getPi Board was called')
    try {
        board = execSync("cat /proc/device-tree/model").toString();
    } catch (e) {
        self.log("Failed to read Pi board so default to Pi 1!");
        board = "Pi Rev";
    }
    return board;
}
