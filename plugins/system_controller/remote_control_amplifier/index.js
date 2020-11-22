'use strict';

// I used supercrab's gpio_control plugin as a basis for this project
//https://www.nodenpm.com/lirc-client/package.html
var libQ = require("kew");
var fs = require("fs-extra");
const lirc = require('lirc-client')({
	path: '/var/run/lirc/lircd'
  });
var config = new (require("v-conf"))();
var savedDesiredConfig = {"volume":0};
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
var devicename='receiver';
var start_button='KEY_POWER';
var stop_button='KEY_POWER2';
var vol_down_button='KEY_VOLUMEDOWN';
var vol_up_button='KEY_VOLUMEUP';

// behavior related settings - 
var stopToTurnOffDelay = 60;
var keypressTimeOut = 100;

// Events that we can detect and do something
const events = [SYSTEM_STARTUP, SYSTEM_SHUTDOWN, MUSIC_PLAY, MUSIC_PAUSE, MUSIC_STOP,VOLUME_CHANGE];

module.exports = IRControl;


// Constructor
// on the constructor, this needs to be heavily changed to initializa all the IR specific stuff 
function IRControl(context) {
	var self = this;
	self.context = context;
	self.commandRouter = self.context.coreCommand;
	self.logger = self.context.logger;
	self.load18nStrings();
	self.stopRequested = false;
	self.stopInProgress = false;
	// assume that the amplifier has been turned off
	self.log('Initializing IRControl');
	self.amplifierOn = false;
}

// Volumio is starting
// read the states from the config file 
IRControl.prototype.onVolumioStart = function(){
	var self = this;
	self.log('onVolumioStart');
	var configFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, "config.json");
	
	return libQ.resolve();
}

// Volumio is shutting down
// todo - on volumio shutdown let's save the state and compare with what does mpd says about it (volume for example)
// on stopping volumio, we may need to set the amplifier to play back radio or something (not sure yet)
IRControl.prototype.onVolumioShutdown = function() {
	var self = this;
	socket.emit("getState", "");
	socket.on("pushState",  function (state) {
	self.handleEvent(SYSTEM_SHUTDOWN,state);
	})
	return libQ.resolve();
};

// Return config filename
IRControl.prototype.getConfigurationFiles = function() {
	return ["config.json"];
}

// Plugin has started
IRControl.prototype.onStart = function() {
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

	self.recreateState()
		.then (function(result) {
			self.log("State created from configuration");
			state
			self.handleEvent(SYSTEM_STARTUP);
			defer.resolve();
		});

	return defer.promise;
};

// Pluging has stopped
IRControl.prototype.onStop = function() {
	//todo let's save all the states of volumio to the config file 
	var self = this;
	var defer = libQ.defer();

	self.saveStatesToFile()
		.then (function(result) {
			self.log("State was saved to config file ");
			defer.resolve();
		});

	return libQ.resolve();
};

// The usual plugin guff :p

IRControl.prototype.onRestart = function() {
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

IRControl.prototype.setConf = function(varName, varValue) {
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
IRControl.prototype.getUIConfig = function() {
	var defer = libQ.defer();
	var self = this;
	var lang_code = self.commandRouter.sharedVars.get("language_code");
	var UIConfigFile;

	// Depending on our pi version change the number of pins available in GUI
	// todo UIConfig.json will need to be changed according to the amplifier's stuff 
	if (self.piBoard.fullGPIO)
		UIConfigFile = __dirname + "/UIConfig.json";
	else
		UIConfigFile = __dirname  + "/UIConfig-OldSchool.json";

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
				uiconf.sections[0].content.findItem = function(obj) {
					return this.find(function(item) {
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
		.fail(function()
		{
			defer.reject(new Error());
		});

	return defer.promise;
};

// Save config
IRControl.prototype.saveConfig = function(data){
	// when we save the config, we need to save the volume state of MPD 
	var self = this;

	self.log("Saving config");
	config.set('volume',this.savedDesiredConfig.volume)

	self.commandRouter.pushToastMessage('success', self.getI18nString("PLUGIN_CONFIGURATION"), self.getI18nString("SETTINGS_SAVED"));
};

IRControl.prototype.saveDesiredState = function(data) {
	// not yet used 
	var self = this;
	savedDesiredConfig.set("volume",data.volume)
	savedDesiredConfig.set("on",data.on)
	return libQ.resolve();
};



IRControl.prototype.setVolume = async function(newvolume) {
	var self = this;
	var currentvolume = savedDesiredConfig.volume

	// somehow we need to be sure that we are doing only one operation at once

	// todo implement queuing mechanism that is watching the change of this variable 

	if (newvolume < currentvolume) {
		self.log("Decreasing volume from "+currentvolume+" to "+newvolume)
		for (var i = 0; i < currentvolume-newvolume; i++) {
			self.decreaseVolume();
			await new Promise(resolve => setTimeout(resolve, keypressTimeOut));
	}
}
	if (newvolume > currentvolume) {
		self.log("Increasing volume from "+currentvolume+" to "+newvolume)
		for (var i = 0; i < newvolume-currentvolume; i++) {
			self.increaseVolume();
			await new Promise(resolve => setTimeout(resolve, keypressTimeOut));
	}
}
	savedDesiredConfig={"volume":newvolume}
}

IRControl.prototype.increaseVolume = function() {
	lirc.sendOnce(devicename, vol_up_button).catch(error => {
        if (error) this.log(error);
    });
}

IRControl.prototype.decreaseVolume = function() {
	
	lirc.sendOnce(devicename, vol_down_button).catch(error => {
        if (error) this.log(error);
	});
}

IRControl.prototype.turnItOff = function() {
	lirc.sendOnce(devicename, stop_button).catch(error => {
        if (error) this.log(error);
	});
}

IRControl.prototype.turnItOn = function() {
	lirc.sendOnce(devicename, start_button).catch(error => {
        if (error) this.log(error);
	});
}


IRControl.prototype.turnOffAmplifier =  function() {
	// handles stopping the amplifier and all the state machines 
	var self = this;
	self.log('Stopping the amplifier')
	self.turnItOff();
	self.amplifierOn = false;
	self.stopInProgress = false;
	self.log('Amplifier was turned off')
}

IRControl.prototype.turnOnAmplifier = function() {
	// if there is a counter already started to stop the amplifier, stop this and press the power button (anyway it doesn't hurt)
	var self = this;
	self.stopInProgress=false;
	self.stopRequested=false;
	self.log('Turning the amplifier on ')
	self.turnItOn();
	self.amplifierOn=true;
}

IRControl.prototype.turnOffAmplifierWithDelay = async function() {
	var self = this;
	if (! self.stopInProgress) {
		self.log('Playback was stopped, amplifier will be turned off in '+stopToTurnOffDelay+' seconds')
		self.stopInProgress=true;
		self.stopRequested = true;
		return new Promise(function(resolve,reject) {
			setTimeout(() => {
				if (self.stopRequested) {
					self.turnOffAmplifier();
					self.stopRequested = false;
					resolve();
				} else {
					self.stopInProgress=false;
				}
			}, stopToTurnOffDelay * 1000)
		})
	}
}



IRControl.prototype.compareStates = function(data) {
	var self = this;
	if (self.desiredconfig.volume != data.volume) {
		self.log("Need to increase volume to "+data.volume)
		self.setVolume(data.volume)
	}
}


// Create ir objects for future events
// todo this function needs to be replaced with ir specific stuff 
IRControl.prototype.recreateState = function() {
	var self = this;
	self.log("Reading config and setting volumes");
	self.log("recreateState was called")
	config.loadFile(configFile);
	this.savedDesiredConfig.volume=config.volume;
	return libQ.resolve();
};

// Release our ircontrol objects
// todo not sure that this is necessary in our case 
IRControl.prototype.saveStatesToFile = function () {
	var self = this;

	self.log("saveStatesToFile was called")
	config.set("volume",savedDesiredConfig.volume)
	
	config.save();

	return libQ.resolve();
};

// Playing status has changed
// (might not always be a play or pause action)
IRControl.prototype.statusChanged = function(state) {
	var self = this;
	self.log('State is like '+state)
	if (state.status == "play")
		self.handleEvent(MUSIC_PLAY,state);
	else if (state.status == "pause")
		self.handleEvent(MUSIC_PAUSE,state);
	else if (state.status == "stop")
		self.handleEvent(MUSIC_STOP,state);
}

// An event has happened so do something about it
// handleevent needs to look at the event and check all the stuff that mpd has to offer 
IRControl.prototype.handleEvent = function(e,state= {"volume":1}) {
	var self = this;
	self.log('handleEvent was called for '+e)
	self.log('handleEvent full state is like:'+state.volume);
	desiredstate = {"volume":state.volume}
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
		// handle system startup 
	}
}

// Output to log
IRControl.prototype.log = function(s) {
	var self = this;
	self.logger.info("[amplifier_remote_Control] " + s);
}

// Function for printing booleans
IRControl.prototype.boolToString = function(value){
	var self = this;
	return value ? self.getI18nString("ON") : self.getI18nString("OFF");
}

// A method to get some language strings used by the plugin
IRControl.prototype.load18nStrings = function() {
    var self = this;

    try {
        var language_code = this.commandRouter.sharedVars.get('language_code');
        self.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_' + language_code + ".json");
    }
    catch (e) {
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
IRControl.prototype.getUIElement = function(obj, field){
	var self = this;
	self.log('getUIElement was called')
	var lookfor = JSON.parse('{"id":"' + field + '"}');
	return obj.sections[0].content.findItem(lookfor);
}

// Populate switch UI element
IRControl.prototype.setSwitchElement = function(obj, field, value){
	var self = this;
	self.log('setSwitchElement was called')
	var result = self.getUIElement(obj, field);
	if (result)
		result.value = value;
}

// Populate select UI element
IRControl.prototype.setSelectElement = function(obj, field, value, label){
	var self = this;
	self.log('setSelectElement was called')
	var result = self.getUIElement(obj, field);
	if (result){
		result.value.value = value;
		result.value.label = label;
	}
}

// Populate select UI element when value matches the label
IRControl.prototype.setSelectElementStr = function(obj, field, value){
	var self = this;
	self.setSelectElement(obj, field, value, value.toString());
}
