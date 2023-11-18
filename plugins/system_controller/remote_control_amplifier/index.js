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
var socket;
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
var keypressTimeOut = 200;

// Events that we can detect and do something
const events = [SYSTEM_STARTUP, SYSTEM_SHUTDOWN, MUSIC_PLAY, MUSIC_PAUSE, MUSIC_STOP, VOLUME_CHANGE];

module.exports = IRControl;


// Constructor
// on the constructor, this needs to be heavily changed to initializa all the IR specific stuff
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
    this.savedDesiredConfig = {"volume": 0};
    this.desiredVolume = 0;
    this.volumeOperationInProgress = false;
}

// Volumio is starting
// read the states from the config file
IRControl.prototype.onVolumioStart = function () {
    var self = this;
    this.log('onVolumioStart');
    var configFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, "config.json");
    config.loadFile(configFile);
    this.savedDesiredConfig.volume = config.data.volume;
    this.log(`Loaded configuration from ${self.savedDesiredConfig}`);
    this.desiredVolume = self.savedDesiredConfig.volume;
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


IRControl.prototype.volumeListener = function () {
    var self = this;
    self.log("Starting volumeListener");
    if (socket) {
        socket.disconnect();
        socket = undefined;
        self.log("Destroyed socket");
    }
    socket= io.connect('http://localhost:3000');
    self.log("Called connect socket.");
    socket.emit("getState", "");
    self.log("sent getState");
    socket.on("connect", function(){
        socket.on("pushState", function(state) {
            if (state && state.volume !== undefined && state.mute !== undefined && Number.isInteger(state.volume)) {
                let volume = parseInt(state.volume);
                let mute = state.mute;
                self.log(`here is a new state: ${state}`);
                if (mute) {
                    volume = 0;
                }
                if (state.service !== undefined) {
                    currentService = state.service;
                }
                self.statusChanged(state);
            }
        });
    });
};




// Plugin has started
IRControl.prototype.onStart = function () {
    var self = this;
    var defer = libQ.defer();
    this.volumeListener();
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

    // Depending on our pi version change the number of pins available in GUI
    // todo UIConfig.json will need to be changed according to the amplifier's stuff
    UIConfigFile = __dirname + "/UIConfig.json";
    self.log(`UI Config file ${UIConfigFile}`);

    // add Hungarian
    self.commandRouter.i18nJson(
        __dirname + "/i18n/strings_" + lang_code + ".json",
        __dirname + "/i18n/strings_en.json",
        UIConfigFile
    )
        .then(function (uiconf) {
            uiconf.sections[0].content[0].value = self.config.get('amplifierType');
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
    config.set('volume', data['amplifierType']);
    config.set('amplifierOn', data['amplifierType']);
    self.log("Saving config");
    self.commandRouter.pushToastMessage('success', self.getI18nString("PLUGIN_CONFIGURATION"), self.getI18nString("SETTINGS_SAVED"));
};

IRControl.prototype.saveDesiredState = function (data) {
    // not yet used
    var self = this;
    self.savedDesiredConfig.set("volume", data.volume);
    self.savedDesiredConfig.set("on", data.on);
    return libQ.resolve();
};


IRControl.prototype.setVolume = async function (newvolume) {
    var self = this;

    var indexer = 0;
    self.desiredVolume = newvolume;

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
    self.volumeOperationInProgress = false;
    self.savedDesiredConfig = {"volume": self.desiredVolume};
}

IRControl.prototype.increaseVolume = function () {
    var self = this;
    lirc.sendOnce(devicename, vol_up_button).catch(error => {
        if (error) self.log('error occurred during increaseVolumio'+ String(error));
    });
    self.log('Increased volume by a bit');
    self.savedDesiredConfig.volume = self.savedDesiredConfig.volume + 1;
}

IRControl.prototype.decreaseVolume = function () {
    var self = this;
    lirc.sendOnce(devicename, vol_down_button).catch(error => {
        if (error) self.log('error occurred during decreaseVolume'+ String(error));
        self.log('Decreased volume by a bit');
    });
    self.log('decreased volume by a bit');
    self.savedDesiredConfig.volume = self.savedDesiredConfig.volume - 1;
}

IRControl.prototype.turnItOff = function () {
    var self = this;
    lirc.sendOnce(devicename, stop_button).catch(error => {
        self.log('Sending:' + stop_button);
        if (error) self.log('error occurred during turnItOff'+ String(error));
    });
}

IRControl.prototype.turnItOn = function () {
    var self = this;
    lirc.sendOnce(devicename, start_button).catch(error => {
        self.log('Sending:' + start_button);
        if (error) self.log('error occurred during turnItOn'+ String(error));
    });
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

IRControl.prototype.turnOnAmplifier = function () {
    // if there is a counter already started to stop the amplifier, stop this and press the power button (anyway it doesn't hurt)
    var self = this;
    self.stopInProgress = false;
    self.stopRequested = false;
    self.turnItOn();
    self.amplifierOn = true;

}

IRControl.prototype.compareStates = function (data) {
    var self = this;
    if (self.desiredconfig.volume != data.volume) {
        self.log("Need to increase volume to " + data.volume);
        self.setVolume(data.volume);
    }
}


// Create ir objects for future events
// todo this function needs to be replaced with ir specific stuff
IRControl.prototype.recreateState = function () {
    var self = this;
    self.log("Reading config and setting volumes");
    var configFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, "config.json");
    config.loadFile(configFile);
    self.log("recreateState was called");
    self.savedDesiredConfig.volume = config.volume;
    self.log("recreateState has ended");
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
IRControl.prototype.handleEvent = function (e, state = {"volume": 1}) {
    var self = this;
    self.log('handleEvent was called for ' + e);
    self.log('handleEvent volume state is like:' + state.volume);
    self.saveDesiredState = {"volume": state.volume};
    self.setVolume(state.volume);
    if (e == MUSIC_PAUSE) {
        self.turnOffAmplifierWithDelay();
    }
    if (e == MUSIC_STOP) {
        self.turnOffAmplifierWithDelay();
    }
    if (e == MUSIC_PLAY) {
        self.turnOnAmplifier();
    }
    if (e == SYSTEM_SHUTDOWN) {
        self.self.turnItOff();
    }
    if (e == SYSTEM_STARTUP) {
        self.log('This is startup - we assume that the amplifier is stopped.');
        self.amplifierOn = false;
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
