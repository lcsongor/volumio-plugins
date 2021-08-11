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
    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.load18nStrings();
    this.piBoard = this.getPiBoardInfo();
    this.stopRequested = false;
    this.stopInProgress = false;
    // assume that the amplifier has been turned off
    this.log('Initializing IRControl');
    this.amplifierOn = false;
    this.savedDesiredConfig = {"volume": 0};
    this.operationInProgress = false;
    this.desiredVolume = 0;
    this.actualVolume = 0;
}

// Volumio is starting
// read the states from the config file 
IRControl.prototype.onVolumioStart = function () {

    this.log('onVolumioStart');
    var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, "config.json");
    config.loadFile(configFile);
    this.savedDesiredConfig.volume = config.data.volume;
    this.desiredVolume = this.savedDesiredConfig.volume;
    this.actualVolume = this.desiredVolume;
    this.log('All config is like'+JSON.stringify(config));
    this.log('onVolumioStart: actualVolume'+this.actualVolume);
    this.log('onVolumioStart: desiredVolume'+this.desiredVolume);
    this.amplifierOn = false;
    this.log(`Detected ${this.piBoard.name}`);
    this.log(`40 GPIOs: ${this.piBoard.fullGPIO}`);
    this.log("Initialized");

    return libQ.resolve();
}

// Volumio is shutting down
// todo - on volumio shutdown let's save the state and compare with what does mpd says about it (volume for example)
// on stopping volumio, we may need to set the amplifier to play back radio or something (not sure yet)
IRControl.prototype.onVolumioShutdown = function () {

    socket.emit("getState", "");
    socket.on("pushState", function (state) {
        this.handleEvent(SYSTEM_SHUTDOWN, state);
    })
    return libQ.resolve();
};

// Return config filename
IRControl.prototype.getConfigurationFiles = function () {
    return ["config.json"];
}

// Plugin has started
IRControl.prototype.onStart = function () {

    var defer = libQ.defer();

    // read and parse status once
    socket.emit("getState", "");
    socket.once("pushState", this.statusChanged.bind(this));
    this.log('onStart was called')
    // listen to every subsequent status report from Volumio
    // status is pushed after every playback action, so we will be
    // notified if the status changes
    socket.on("pushState", this.statusChanged.bind(this));

    // Create pin objects
    // todo chek if everything is alright with the lirc sender
    this.recreateState()
        .then(function (result) {
            this.log("State created from configuration created");
            state
            this.handleEvent(SYSTEM_STARTUP);
            defer.resolve();
        });

    return defer.promise;
};

// Pluging has stopped
IRControl.prototype.onStop = function () {
    //todo let's save all the states of volumio to the config file

    var defer = libQ.defer();

    this.saveStatesToFile()
        .then(function (result) {
            this.log("State was saved to config file ");
            defer.resolve();
        });

    return libQ.resolve();
};

// The usual plugin guff :p

IRControl.prototype.onRestart = function () {

};

IRControl.prototype.onInstall = function () {

};

IRControl.prototype.onUninstall = function () {

};

IRControl.prototype.getConf = function (varName) {

};

IRControl.prototype.setConf = function (varName, varValue) {

};

IRControl.prototype.getAdditionalConf = function (type, controller, data) {

};

IRControl.prototype.setAdditionalConf = function () {

};

IRControl.prototype.setUIConfig = function (data) {

};

// Read config from UI
IRControl.prototype.getUIConfig = function () {
    var defer = libQ.defer();

    var lang_code = this.commandRouter.sharedVars.get("language_code");
    var UIConfigFile;

    // Depending on our pi version change the number of pins available in GUI
    // todo UIConfig.json will need to be changed according to the amplifier's stuff
    if (this.piBoard.fullGPIO)
        UIConfigFile = __dirname + "/UIConfig.json";
    else
        UIConfigFile = __dirname + "/UIConfig-OldSchool.json";

    this.log(`UI Config file ${UIConfigFile}`);

    // add Hungarian
    this.commandRouter.i18nJson(
        __dirname + "/i18n/strings_" + lang_code + ".json",
        __dirname + "/i18n/strings_en.json",
        UIConfigFile
    )
        .then(function (uiconf) {
            //var i = 0;
            //todo this is not needed. We need to get the last volume, to configure it
            events.forEach(function (e) {

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
                this.setSwitchElement(uiconf, s1, config.get(c1));
                this.setSelectElementStr(uiconf, s2, config.get(c2));
                this.setSelectElement(uiconf, s3, config.get(c3), this.boolToString(config.get(c3)));
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


    this.log("Saving config");
    config.set('volume', this.savedDesiredConfig.volume)
    config.set('amplifierOn', this.amplifierOn)

    this.commandRouter.pushToastMessage('success', this.getI18nString("PLUGIN_CONFIGURATION"), this.getI18nString("SETTINGS_SAVED"));
};

IRControl.prototype.setVolume = async function (newvolume) {

    this.desiredVolume = newvolume;
    this.log('Requested volume is ' + this.desiredVolume);
    this.log('Current volume on system ' + this.actualVolume);
    this.log('Operations in progress ' + this.operationInProgress);


    while (this.operationInProgress === true) {
        this.log('Another operation is in progres waiting to set:' + newvolume)
        await new Promise(resolve => setTimeout(resolve, keypressTimeOut));
    }

    if (this.desiredVolume < this.actualVolume) {
        this.log("Decreasing volume from " + this.actualVolume + " to " + newvolume)
        this.operationInProgress = true;
        for (var i = 0; i < this.actualVolume - this.desiredVolume; i++) {
            this.decreaseVolume();
            this.log('Decreasing Waiting for ' + String(keypressTimeOut));
            await new Promise(resolve => setTimeout(resolve, keypressTimeOut));
        }
        this.operationInProgress = false;
    }
    if (this.desiredVolume > this.actualVolume) {
        this.log("Increasing volume from " + this.actualVolume + " to " + this.desiredVolume)
        this.operationInProgress = true;
        for (var i = 0; i < this.desiredVolume - this.actualVolume; i++) {
            this.increaseVolume();
            this.log('Increasing Waiting for ' + String(keypressTimeOut));
            await new Promise(resolve => setTimeout(resolve, keypressTimeOut));
        }
        this.operationInProgress = false;
    }
    this.savedDesiredConfig = {"volume": newvolume}
}

IRControl.prototype.increaseVolume = function () {
    lirc.sendOnce(devicename, vol_up_button).catch(error => {
        if (error) this.log(error)
        else {
            this.actualVolume = this.actualVolume + 1;
            this.log('Increased volume by a bit');
        }
    });
}

IRControl.prototype.decreaseVolume = function () {
    lirc.sendOnce(devicename, vol_down_button).catch(error => {
        if (error) this.log(error)
        else {
            this.actualVolume = this.actualVolume - 1;
            this.log('Decreased volume by a bit');
        }
    });

}

IRControl.prototype.turnItOff = function () {
    lirc.sendOnce(devicename, stop_button).catch(error => {
        this.log('Sending:' + stop_button);
        if (error) this.log(error);
    });
}

IRControl.prototype.turnItOn = function () {
    lirc.sendOnce(devicename, start_button).catch(error => {
        this.log('Sending:' + start_button);
        if (error) this.log(error);
    });
}


IRControl.prototype.turnOffAmplifierWithDelay = async function () {

    if (!this.stopInProgress) {
        this.log('Playback was stopped, amplifier will be turned off in ' + stopToTurnOffDelay + ' seconds')
        this.stopInProgress = true;
        this.stopRequested = true;
        return new Promise(function (resolve, reject) {
            setTimeout(() => {
                this.log('Stopping the amplifier')
                if (this.stopRequested === true) {
                    this.turnItOff();
                    this.log('Amplifier was turned off')
                    this.amplifierOn = false;
                    this.stopInProgress = false;
                    this.stopRequested = false;
                    resolve();
                } else {
                    this.log('Stopping was cancelled');
                    this.stopRequested = false;
                    this.stopInProgress = false;
                }
            }, stopToTurnOffDelay * 1000)
        })
    }
}

IRControl.prototype.turnOnAmplifier = function () {
    // if there is a counter already started to stop the amplifier, stop this and press the power button (anyway it doesn't hurt)

    this.stopInProgress = false;
    this.stopRequested = false;
    if (this.amplifierOn === false) {
        this.log('Playback started - turning the amplifier on ')
        this.turnItOn();
        this.amplifierOn = true;
    }
}

IRControl.prototype.compareStates = function (data) {

    if (this.desiredconfig.volume != data.volume) {
        this.log("Need to increase volume to " + data.volume)
        this.setVolume(data.volume)
    }
}


// Create ir objects for future events
// todo this function needs to be replaced with ir specific stuff 
IRControl.prototype.recreateState = function () {

    this.log("Reading config and setting volumes");
    this.log("recreateState was called")
    var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, "config.json");
    config.loadFile(configFile);
    this.savedDesiredConfig.volume = config.volume;
    return libQ.resolve();
};

// Release our ircontrol objects
// todo not sure that this is necessary in our case 
IRControl.prototype.saveStatesToFile = function () {


    this.log("saveStatesToFile was called")
    config.set("volume", this.savedDesiredConfig.volume)
    config.set("amplifierOn", this.amplifierOn)
    config.save();

    return libQ.resolve();
};

// Playing status has changed
// (might not always be a play or pause action)
IRControl.prototype.statusChanged = function (state) {

    this.log('State is like ' + String(state.status));
    if (state.status == "play")
        this.handleEvent(MUSIC_PLAY, state);
    else if (state.status == "pause")
        this.handleEvent(MUSIC_PAUSE, state);
    else if (state.status == "stop")
        this.handleEvent(MUSIC_STOP, state);
}

// An event has happened so do something about it
// handleevent needs to look at the event and check all the stuff that mpd has to offer 
IRControl.prototype.handleEvent = function (e, state = {"volume": 1}) {

    this.log('handleEvent was called for ' + e)
    this.log('handleEvent volume state is like:' + state.volume);
    this.setVolume(state.volume);
    if (e == MUSIC_PAUSE) {
        this.turnOffAmplifierWithDelay();
    }
    if (e == MUSIC_STOP) {
        this.turnOffAmplifierWithDelay();
    }
    if (e == MUSIC_PLAY) {
        this.turnOnAmplifier();
    }
    if (e == SYSTEM_SHUTDOWN) {
        this.saveConfig()
        this.tu
        // handle system shutdown
    }
    if (e == SYSTEM_STARTUP) {
        this.amplifierOn = false;
        // handle system startup
    }
}

// Output to log
IRControl.prototype.log = function (s) {

    this.logger.info("[amplifier_remote_Control] " + s);
}

// Function for printing booleans
IRControl.prototype.boolToString = function (value) {

    return value ? this.getI18nString("ON") : this.getI18nString("OFF");
}

// A method to get some language strings used by the plugin
IRControl.prototype.load18nStrings = function () {


    try {
        var language_code = this.commandRouter.sharedVars.get('language_code');
        this.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_' + language_code + ".json");
    } catch (e) {
        this.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
    }

    this.i18nStringsDefaults = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
};

// Retrieve a string
IRControl.prototype.getI18nString = function (key) {


    if (this.i18nStrings[key] !== undefined)
        return this.i18nStrings[key];
    else
        return this.i18nStringsDefaults[key];
};

// Retrieve a UI element from UI config
IRControl.prototype.getUIElement = function (obj, field) {

    this.log('getUIElement was called')
    var lookfor = JSON.parse('{"id":"' + field + '"}');
    return obj.sections[0].content.findItem(lookfor);
}

// Populate switch UI element
IRControl.prototype.setSwitchElement = function (obj, field, value) {

    this.log('setSwitchElement was called')
    var result = this.getUIElement(obj, field);
    if (result)
        result.value = value;
}

// Populate select UI element
IRControl.prototype.setSelectElement = function (obj, field, value, label) {

    this.log('setSelectElement was called')
    var result = this.getUIElement(obj, field);
    if (result) {
        result.value.value = value;
        result.value.label = label;
    }
}

// Populate select UI element when value matches the label
IRControl.prototype.setSelectElementStr = function (obj, field, value) {

    this.setSelectElement(obj, field, value, value.toString());
}

// Retrieves information about the Pi hardware
// Ignores the compute module for now
// todo actually we need to check the status of the infrared devices 
IRControl.prototype.getPiBoardInfo = function () {

    var regex = "(?:Pi)" +
        "(?:\\s(\\d+))?" +
        "(?:\\s(Zero)(?:\\s(W))?)?" +
        "(?:\\sModel\\s(?:([AB])(?:\\s(Plus))?))?" +
        "(?:\\sRev\\s(\\d+)(?:\\.(\\d+))?)?";
    var re = new RegExp(regex, "gi"); // global and case insensitive
    var boardName = this.getPiBoard(); // Returns Pi 1 as a defualt
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
    this.log('getPiBoardInfo loaded')
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

    var board;
    this.log('getPi Board was called')
    try {
        board = execSync("cat /proc/device-tree/model").toString();
    } catch (e) {
        this.log("Failed to read Pi board so default to Pi 1!");
        board = "Pi Rev";
    }
    return board;
}
