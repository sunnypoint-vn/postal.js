/**
 * postal - Pub/Sub library providing wildcard subscriptions, complex message handling, etc.  Works server and client-side.
 * Author: Jim Cowart (http://freshbrewedcode.com/jimcowart)
 * Version: v0.8.11
 * Url: http://github.com/postaljs/postal.js
 * License(s): MIT, GPL
 */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        // Node, or CommonJS-Like environments
        module.exports = factory(require("underscore"), this);
    } else if (typeof define === "function" && define.amd) {
        // AMD. Register as an anonymous module.
        define(["underscore"], function (_) {
            return factory(_, root);
        });
    } else {
        // Browser globals
        root.postal = factory(root._, root);
    }
}(this, function (_, global, undefined) {

    var postal;
    var prevPostal = global.postal;

    var Strategy = function (options) {
        var _target = options.owner[options.prop];
        if (typeof _target !== "function") {
            throw new Error("Strategies can only target methods.");
        }
        var _strategies = [];
        var _context = options.context || options.owner;
        var strategy = function () {
            var idx = 0;
            var next = function next() {
                var args = Array.prototype.slice.call(arguments, 0);
                var thisIdx = idx;
                var strategy;
                idx += 1;
                if (thisIdx < _strategies.length) {
                    strategy = _strategies[thisIdx];
                    strategy.fn.apply(strategy.context || _context, [next].concat(args));
                } else {
                    _target.apply(_context, args);
                }
            };
            next.apply(this, arguments);
        };
        strategy.target = function () {
            return _target;
        };
        strategy.context = function (ctx) {
            if (arguments.length === 0) {
                return _context;
            } else {
                _context = ctx;
            }
        };
        strategy.strategies = function () {
            return _strategies;
        };
        strategy.useStrategy = function (strategy) {
            var idx = 0,
                exists = false;
            while (idx < _strategies.length) {
                if (_strategies[idx].name === strategy.name) {
                    _strategies[idx] = strategy;
                    exists = true;
                    break;
                }
                idx += 1;
            }
            if (!exists) {
                _strategies.push(strategy);
            }
        };
        strategy.reset = function () {
            _strategies = [];
        };
        if (options.lazyInit) {
            _target.useStrategy = function () {
                options.owner[options.prop] = strategy;
                strategy.useStrategy.apply(strategy, arguments);
            };
            _target.context = function () {
                options.owner[options.prop] = strategy;
                return strategy.context.apply(strategy, arguments);
            };
            return _target;
        } else {
            return strategy;
        }
    };

    var ChannelDefinition = function (channelName) {
        this.channel = channelName || postal.configuration.DEFAULT_CHANNEL;
    };

    ChannelDefinition.prototype.subscribe = function () {
        return postal.subscribe(arguments.length === 1 ? new SubscriptionDefinition(this.channel, arguments[0].topic, arguments[0].callback) : new SubscriptionDefinition(this.channel, arguments[0], arguments[1]));
    };

    ChannelDefinition.prototype.publish = function () {
        var envelope = arguments.length === 1 ? (Object.prototype.toString.call(arguments[0]) === "[object String]" ? {
            topic: arguments[0]
        } : arguments[0]) : {
            topic: arguments[0],
            data: arguments[1]
        };
        envelope.channel = this.channel;
        return postal.configuration.bus.publish(envelope);
    };


    var SubscriptionDefinition = function (channel, topic, callback) {
        if (arguments.length !== 3) {
            throw new Error("You must provide a channel, topic and callback when creating a SubscriptionDefinition instance.");
        }
        if (topic.length === 0) {
            throw new Error("Topics cannot be empty");
        }
        this.channel = channel;
        this.topic = topic;
        this.subscribe(callback);
    };

    SubscriptionDefinition.prototype = {
        unsubscribe: function () {
            if (!this.inactive) {
                this.inactive = true;
                postal.unsubscribe(this);
            }
        },

        subscribe: function (callback) {
            this.callback = callback;
            this.callback = new Strategy({
                owner: this,
                prop: "callback",
                context: this,
                // TODO: is this the best option?
                lazyInit: true
            });
            return this;
        },

        withContext: function (context) {
            this.callback.context(context);
            return this;
        }
    };




    var bindingsResolver = {
        cache: {},
        regex: {},

        compare: function (binding, topic) {
            var pattern, rgx, prevSegment, result = (this.cache[topic] && this.cache[topic][binding]);
            if (typeof result !== "undefined") {
                return result;
            }
            if (!(rgx = this.regex[binding])) {
                pattern = "^" + _.map(binding.split("."), function (segment) {
                    var res = "";
                    if ( !! prevSegment) {
                        res = prevSegment !== "#" ? "\\.\\b" : "\\b";
                    }
                    if (segment === "#") {
                        res += "[\\s\\S]*";
                    } else if (segment === "*") {
                        res += "[^.]+";
                    } else {
                        res += segment;
                    }
                    prevSegment = segment;
                    return res;
                }).join("") + "$";
                rgx = this.regex[binding] = new RegExp(pattern);
            }
            this.cache[topic] = this.cache[topic] || {};
            this.cache[topic][binding] = result = rgx.test(topic);
            return result;
        },

        reset: function () {
            this.cache = {};
            this.regex = {};
        }
    };

    var fireSub = function (subDef, envelope) {
        if (!subDef.inactive && postal.configuration.resolver.compare(subDef.topic, envelope.topic)) {
            if (_.all(subDef.constraints, function (constraint) {
                return constraint.call(subDef.context, envelope.data, envelope);
            })) {
                if (typeof subDef.callback === "function") {
                    subDef.callback.call(subDef.context, envelope.data, envelope);
                }
            }
        }
    };

    var pubInProgress = 0;
    var unSubQueue = [];
    var clearUnSubQueue = function () {
        while (unSubQueue.length) {
            localBus.unsubscribe(unSubQueue.shift());
        }
    };

    var localBus = {
        addWireTap: function (callback) {
            var self = this;
            self.wireTaps.push(callback);
            return function () {
                var idx = self.wireTaps.indexOf(callback);
                if (idx !== -1) {
                    self.wireTaps.splice(idx, 1);
                }
            };
        },

        publish: function (envelope) {
            ++pubInProgress;
            envelope.timeStamp = new Date();
            _.each(this.wireTaps, function (tap) {
                tap(envelope.data, envelope);
            });
            if (this.subscriptions[envelope.channel]) {
                _.each(this.subscriptions[envelope.channel], function (subscribers) {
                    var idx = 0,
                        len = subscribers.length,
                        subDef;
                    while (idx < len) {
                        if (subDef = subscribers[idx++]) {
                            fireSub(subDef, envelope);
                        }
                    }
                });
            }
            if (--pubInProgress === 0) {
                clearUnSubQueue();
            }
            return envelope;
        },

        reset: function () {
            if (this.subscriptions) {
                _.each(this.subscriptions, function (channel) {
                    _.each(channel, function (topic) {
                        while (topic.length) {
                            topic.pop().unsubscribe();
                        }
                    });
                });
                this.subscriptions = {};
            }
        },

        subscribe: function (subDef) {
            var channel = this.subscriptions[subDef.channel],
                subs;
            if (!channel) {
                channel = this.subscriptions[subDef.channel] = {};
            }
            subs = this.subscriptions[subDef.channel][subDef.topic];
            if (!subs) {
                subs = this.subscriptions[subDef.channel][subDef.topic] = [];
            }
            subs.push(subDef);
            return subDef;
        },

        subscriptions: {},

        wireTaps: [],

        unsubscribe: function (config) {
            if (pubInProgress) {
                unSubQueue.push(config);
                return;
            }
            if (this.subscriptions[config.channel] && this.subscriptions[config.channel][config.topic]) {
                var len = this.subscriptions[config.channel][config.topic].length,
                    idx = 0;
                while (idx < len) {
                    if (this.subscriptions[config.channel][config.topic][idx] === config) {
                        this.subscriptions[config.channel][config.topic].splice(idx, 1);
                        break;
                    }
                    idx += 1;
                }
            }
        }
    };


    postal = {
        configuration: {
            bus: localBus,
            resolver: bindingsResolver,
            DEFAULT_CHANNEL: "/",
            SYSTEM_CHANNEL: "postal"
        },

        ChannelDefinition: ChannelDefinition,
        SubscriptionDefinition: SubscriptionDefinition,

        channel: function (channelName) {
            return new ChannelDefinition(channelName);
        },

        subscribe: function (options) {
            var subDef = new SubscriptionDefinition(options.channel || postal.configuration.DEFAULT_CHANNEL, options.topic, options.callback);
            postal.configuration.bus.publish({
                channel: postal.configuration.SYSTEM_CHANNEL,
                topic: "subscription.created",
                data: {
                    event: "subscription.created",
                    channel: subDef.channel,
                    topic: subDef.topic
                }
            });
            return postal.configuration.bus.subscribe(subDef);
        },

        publish: function (envelope) {
            envelope.channel = envelope.channel || postal.configuration.DEFAULT_CHANNEL;
            return postal.configuration.bus.publish(envelope);
        },

        unsubscribe: function (subdef) {
            postal.configuration.bus.unsubscribe(subdef);
            postal.configuration.bus.publish({
                channel: postal.configuration.SYSTEM_CHANNEL,
                topic: "subscription.removed",
                data: {
                    event: "subscription.removed",
                    channel: subdef.channel,
                    topic: subdef.topic
                }
            });
        },

        addWireTap: function (callback) {
            return this.configuration.bus.addWireTap(callback);
        },

        linkChannels: function (sources, destinations) {
            var result = [];
            sources = !_.isArray(sources) ? [sources] : sources;
            destinations = !_.isArray(destinations) ? [destinations] : destinations;
            _.each(sources, function (source) {
                var sourceTopic = source.topic || "#";
                _.each(destinations, function (destination) {
                    var destChannel = destination.channel || postal.configuration.DEFAULT_CHANNEL;
                    result.push(
                    postal.subscribe({
                        channel: source.channel || postal.configuration.DEFAULT_CHANNEL,
                        topic: sourceTopic,
                        callback: function (data, env) {
                            var newEnv = _.clone(env);
                            newEnv.topic = _.isFunction(destination.topic) ? destination.topic(env.topic) : destination.topic || env.topic;
                            newEnv.channel = destChannel;
                            newEnv.data = data;
                            postal.publish(newEnv);
                        }
                    }));
                });
            });
            return result;
        },

        noConflict: function () {
            if (typeof window === "undefined") {
                throw new Error("noConflict can only be used in browser clients which aren't using AMD modules");
            }
            global.postal = prevPostal;
            return this;
        },

        utils: {
            getSubscribersFor: function () {
                var channel = arguments[0],
                    tpc = arguments[1];
                if (arguments.length === 1) {
                    channel = arguments[0].channel || postal.configuration.DEFAULT_CHANNEL;
                    tpc = arguments[0].topic;
                }
                if (postal.configuration.bus.subscriptions[channel] && Object.prototype.hasOwnProperty.call(postal.configuration.bus.subscriptions[channel], tpc)) {
                    return postal.configuration.bus.subscriptions[channel][tpc];
                }
                return [];
            },

            reset: function () {
                postal.configuration.bus.reset();
                postal.configuration.resolver.reset();
            }
        }
    };
    localBus.subscriptions[postal.configuration.SYSTEM_CHANNEL] = {};


    if (global && Object.prototype.hasOwnProperty.call(global, "__postalReady__") && _.isArray(global.__postalReady__)) {
        while (global.__postalReady__.length) {
            global.__postalReady__.shift().onReady(postal);
        }
    }


    return postal;
}));