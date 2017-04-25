//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

'use strict';

const insights = require('../lib/insights');

module.exports = function initializeAppInsights(app, config) {
  let client = undefined;
  const key = config.applicationInsights.instrumentationKey;
  if (key) {
    const appInsights = require('applicationinsights');
    const instance = appInsights.setup(key);
    client = instance.getClient(key);
    instance.start();
  }

  app.use((req, res, next) => {
    // Acknowledge synthetic tests immediately without spending time in more middleware
    if (req.headers && req.headers['synthetictest-id'] !== undefined && req.headers['x-ms-user-agent'] !== undefined && req.headers['x-ms-user-agent'].includes('System Center')) {
      return res.status(204).send();
    }

    // Provide application insight event tracking with correlation ID
    const extraProperties = {
      correlationId: req.correlationId,
    };
    req.insights = insights(extraProperties, client);
    next();
  });
};
