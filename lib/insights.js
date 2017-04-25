//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

'use strict';

const debug = require('debug')('appinsights');

function createWrappedClient(propertiesToInsert, client) {
  const c = {};
  if (client) {
    c.trackEvent = addProperties.bind(client, client.trackEvent, propertiesToInsert, 1, true);
    c.trackException = addProperties.bind(client, client.trackException, propertiesToInsert, undefined, true);
    c.trackMetric = addProperties.bind(client, client.trackMetric, propertiesToInsert, undefined, true);
    c.trackTrace = addProperties.bind(client, client.trackTrace, propertiesToInsert, undefined, true);
    c.trackDependency = addProperties.bind(client, client.trackDependency, propertiesToInsert, 5, false);
  } else {
    c.trackEvent = consoleHandler;
    c.trackException = consoleHandler;
    c.trackMetric = consoleMetric;
    c.trackTrace = consoleHandler;
    c.trackDependency = consoleHandler;
  }
  return c;
}

const consoleHandler = (eventName) => {
  debug(eventName);
};
const consoleMetric = (eventName, eventParameter) => {
  debug(`Metric(${eventName}): ${eventParameter}`);
};

function addProperties(/* original, propertiesToInsert, propertiesPosition, createIfMissing */) {
  const args = Array.prototype.slice.call(arguments);
  const original = args.shift();
  const propertiesToInsert = args.shift();
  const propertiesPosition = args.shift();
  const createIfMissing = args.shift();
  const index = propertiesPosition === undefined ? args.length - 1 : propertiesPosition;
  let properties = args[index];
  const type = typeof properties;
  if (properties === undefined || type !== 'object') {
    if (createIfMissing) {
      properties = {};
      args.push(properties);
    } else {
      debug(`Properties were not found at position ${propertiesPosition}. Instead, the parameter was of type "${type}".`);
      properties = null;
    }
  }
  if (properties) {
    Object.assign(properties, propertiesToInsert);
  }
  original.apply(this, args);
}

module.exports = createWrappedClient;
