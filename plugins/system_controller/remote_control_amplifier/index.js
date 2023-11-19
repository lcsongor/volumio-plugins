'use strict';
// the imports from libraries 
var libQ = require("kew");
var fs = require("fs-extra");
var config = new (require("v-conf"))();
var io = require('socket.io-client');
var socket;

// Event string consts
// Events that we can detect and do something
const SYSTEM_STARTUP = "systemStartup";
const SYSTEM_SHUTDOWN = "systemShutdown";
const MUSIC_PLAY = "musicPlay";
const MUSIC_PAUSE = "musicPause";
const MUSIC_STOP = "musicStop";

// IR device related settings - these are only defaults, subject to change from loading config
const lirc = require('lirc-client')({
    path: '/var/run/lirc/lircd'
});
var start_button = 'KEY_POWER';
var stop_button = 'KEY_POWER2';
var vol_down_button = 'KEY_VOLUMEDOWN';
var vol_up_button = 'KEY_VOLUMEUP';

// behavior related settings -
var stopToTurnOffDelay = 60;
var keypressTimeOut = 600;


module.exports = IRControl;


// Constructor
function IRControl(context) {
    var self = this;
    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.load18nStrings();
    this.stopRequested = false;
    this.stopInProgress = false;
    this.log('Initializing IRControl');
    this.amplifierOn = false;
    this.savedDesiredConfig = {"volume": -1};
    this.desiredVolume = 0;
    this.volumeOperationInProgress = false;
}

// Volumio is starting
// read the states from the config file
IRControl.prototype.onVolumioStart = function () {
    var self = this;
    this.log('onVolumioStart');
    var configFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, "config.json");
    this.config = new (require('v-conf'))();
    // todo itt baj van 
    this.config.loadFile(configFile);
    this.devicename = 'receiver';
    this.log('Configuration has been loaded in:' + JSON.stringify(config));
    this.amplifierOn = false;
    this.log("Initialized");
    return libQ.resolve();
}

IRControl.prototype.getConfigurationFiles = function () {
    return ['config.json'];
}

// Volumio is shutting down
// todo - on volumio shutdown let's save the state and compare with what does mpd says about it (volume for example)
// on stopping volumio, we may need to set the amplifier to play back radio or something (not sure yet)
IRControl.prototype.onVolumioShutdown = function () {
    var self = this;
    self.handleEvent(SYSTEM_SHUTDOWN, state);
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
    self.volumeListener();
    self.log('onStart: finished loading volumeListener');
    defer.resolve();
    return defer.promise;
};

// Pluging has stopped
IRControl.prototype.onStop = function () {
    //todo let's save all the states of volumio to the config file
    var self = this;
    var defer = libQ.defer();
    self.handleEvent(SYSTEM_SHUTDOWN);
    defer.resolve();
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
    self.log(`language_code ${lang_code}`);
    var UIConfigFile;
    UIConfigFile = __dirname + "/UIConfig.json";
    self.log(`UI Config file ${UIConfigFile}`);

    self.commandRouter.i18nJson(
        __dirname + "/i18n/strings_" + lang_code + ".json",
        __dirname + "/i18n/strings_en.json",
        UIConfigFile)
        .then(function (uiconf) {
            uiconf.sections[0].content[0].value = self.config.get('amplifierType','');
            self.log(`getUIConfig sending uiconf`);
            defer.resolve(uiconf);
        })
        .fail(function () {
            self.log(`Error occurred during getUIConff`);
            defer.reject(new Error('Failed to load configuration'));
        });

    return defer.promise;

};

// Save config
IRControl.prototype.saveConfig = function (data) {
    // when we save the config, we need to save the volume state of MPD
    var self = this;
    config.set('amplifierType', data['amplifierType']);
    self.log("Saving config");
    self.commandRouter.pushToastMessage('success', self.getI18nString("PLUGIN_CONFIGURATION"), self.getI18nString("SETTINGS_SAVED"));
};




// Output to log
IRControl.prototype.log = function (s) {
    var self = this;
    self.logger.info("[amplifier_remote_Control] " + s);
}

// Output to log
IRControl.prototype.debug = function (s) {
    var self = this;
    self.logger.debug("[amplifier_remote_Control] " + s);
}

IRControl.prototype.error = function (s) {
    var self = this;
    self.logger.error("[amplifier_remote_Control] " + s);
}


// A method to get some language strings used by the plugin
IRControl.prototype.load18nStrings = function () {
    var self = this;

    try {
        var language_code = self.commandRouter.sharedVars.get('language_code');
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
    self.log('getUIElement was called');
    var lookfor = JSON.parse('{"id":"' + field + '"}');
    return obj.sections[0].content.findItem(lookfor);
}

// Populate switch UI element
IRControl.prototype.setSwitchElement = function (obj, field, value) {
    var self = this;
    self.log('setSwitchElement was called');
    var result = self.getUIElement(obj, field);
    if (result)
        result.value = value;
}

// Populate select UI element
IRControl.prototype.setSelectElement = function (obj, field, value, label) {
    var self = this;
    self.log('setSelectElement was called');
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

// this file will store everything that was taken out of index.js 
IRControl.prototype.volumeListener = function () {
    var self = this;
    self.log("Starting volumeListener before connect");
    socket = io.connect('http://localhost:3000');
    self.log("volumeListener after connect socket.");
    socket.emit("getState", "");
    self.log("sent getState");
    socket.on("connect", function(){
        socket.on("pushState", function(state) {
            if (state && state.volume !== undefined && state.mute !== undefined && Number.isInteger(state.volume)) {
                let volume = parseInt(state.volume);
                let mute = state.mute;
                if (mute) {
                    volume = 0;
                }
                self.statusChanged(state);
            }
        });
    });
};

// Playing status has changed
// (might not always be a play or pause action)
IRControl.prototype.statusChanged = function (state) {
    var self = this;
    self.debug('State is like ' + String(state.status));
    if (state.status == "play") {
        self.debug("we are playing");
        self.handleEvent(MUSIC_PLAY, state);
    }
    else if (state.status == "pause") {
        self.debug("we are pausing");
        self.handleEvent(MUSIC_PAUSE, state);
    }
    else if (state.status == "stop") {
        self.debug("we are stopping");
        self.handleEvent(MUSIC_STOP, state);
    }
}

// An event has happened so do something about it
// handleevent needs to look at the event and check all the stuff that mpd has to offer
// todo refactor to multiple methods 
IRControl.prototype.handleEvent = function (e, state = {"volume": 1}) {
    var self = this;
    self.log('handleEvent was called for ' + e + ' volume:' + state.volume);
    if (e == MUSIC_PAUSE) {
        self.turnOffAmplifierWithDelay();
    }
    if (e == MUSIC_STOP) {
        self.turnOffAmplifierWithDelay();
    }
    if (e == MUSIC_PLAY) {
        self.turnOnAmplifier();
        self.setVolume(state.volume);
    }
    if (e == SYSTEM_SHUTDOWN) {
        self.self.turnItOff();
    }
    if (e == SYSTEM_STARTUP) {
        self.log('This is startup - we assume that the amplifier is stopped.');
        self.amplifierOn = false;
    }
}


// this function will turn off the amplifier
IRControl.prototype.turnItOff = function () {
    var self = this;
    self.debug(`Sending ${self.devicename} the button ${stop_button}`)
    lirc.sendOnce(self.devicename, stop_button).catch(error => {
        if (error) self.error('error occurred during turnItOff'+ String(error));
    });
}

// this function will turn on the amplifier
IRControl.prototype.turnItOn = function () {
    var self = this;
    self.debug(`Sending ${this.devicename} the button ${start_button}`)
    lirc.sendOnce(self.devicename, start_button).catch(error => {
        if (error) self.error('error occurred during turnItOn'+ String(error));
    });
}

IRControl.prototype.turnOnAmplifier = function () {
    // if there is a counter already started to stop the amplifier, stop this and press the power button (anyway it doesn't hurt)
    var self = this;
    self.stopInProgress = false;
    self.stopRequested = false;
    self.turnItOn();
    self.amplifierOn = true;
}


IRControl.prototype.setVolume = async function (newvolume) {
    var self = this;
    var indexer = 0;
    self.desiredVolume = newvolume;
    if (self.savedDesiredConfig.volume<0) {
        self.log(`We are starting up. Let's set the savedDesiredConfig to the ${newvolume}`);
        self.savedDesiredConfig.volume = newvolume; 
    } else {
    while (self.volumeOperationInProgress) {
        self.log('Waiting for operation in progress' + String(keypressTimeOut));
        await new Promise(resolve => setTimeout(resolve, keypressTimeOut));
    }
    if (self.desiredVolume < self.savedDesiredConfig.volume) {
        self.volumeOperationInProgress = true;
        indexer = self.savedDesiredConfig.volume - self.desiredVolume;
        self.log("Decreasing volume from " + self.savedDesiredConfig.volume + " to " + self.desiredVolume + ' in ' + indexer + ' steps ');
        for (var i = 0; i < indexer; i++) {
            self.decreaseVolume();
            self.log('decreasing Waiting for ' + String(keypressTimeOut));
            await new Promise(resolve => setTimeout(resolve, keypressTimeOut));
        }
    }
    if (self.desiredVolume > self.savedDesiredConfig.volume) {
        self.volumeOperationInProgress = true;
        indexer = self.desiredVolume - self.savedDesiredConfig.volume;
        self.log("Increasing volume from " + self.savedDesiredConfig.volume + " to " + self.desiredVolume + ' in ' + indexer + ' steps');
        for (var i = 0; i < indexer; i++) {
            self.increaseVolume();
            self.log('increasing Waiting for ' + String(keypressTimeOut));
            await new Promise(resolve => setTimeout(resolve, keypressTimeOut));
        }
    }
    }
    self.volumeOperationInProgress = false;
    self.savedDesiredConfig = {"volume": self.desiredVolume};
}

IRControl.prototype.increaseVolume = function () {
    var self = this;
    self.debug(`Sending ${self.devicename} the button ${vol_up_button}`)
    lirc.sendOnce(self.devicename, vol_up_button).catch(error => {
        if (error) self.error('error occurred during increaseVolumio'+ String(error));
    });
    self.log('Increased volume by a bit');
    self.savedDesiredConfig.volume = self.savedDesiredConfig.volume + 1;
}

IRControl.prototype.decreaseVolume = function () {
    var self = this;
    self.debug(`Sending ${self.devicename} the button ${vol_down_button}`)
    lirc.sendOnce(self.devicename, vol_down_button).catch(error => {
        if (error) self.error('error occurred during decreaseVolume'+ String(error));
    });
    self.log('Decreased volume by a bit');
    self.savedDesiredConfig.volume = self.savedDesiredConfig.volume - 1;
}

IRControl.prototype.turnOffAmplifierWithDelay = async function () {
    var self = this;
    if (!self.stopInProgress) {
        self.log('Playback was stopped, amplifier will be turned off in ' + stopToTurnOffDelay + ' seconds');
        self.stopInProgress = true;
        self.stopRequested = true;
        return new Promise(function (resolve, reject) {
            setTimeout(() => {
                self.log('Stopping the amplifier');
                if (self.stopRequested === true) {
                    self.turnItOff();
                    self.log('Amplifier was turned off');
                    self.amplifierOn = false;
                    self.stopInProgress = false;
                    self.stopRequested = false;
                    resolve();
                } else {
                    self.log('Stopping was cancelled');
                    self.stopRequested = false;
                    self.stopInProgress = false;
                }
            }, stopToTurnOffDelay * 1000);
        })
    }
}

