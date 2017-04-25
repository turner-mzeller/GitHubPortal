//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

const session = require('express-session');
const RedisStore = require('connect-redis')(session);

module.exports = function (config, redisClient) {
  var redisOptions = {
    client: redisClient,
    ttl: config.redis.ttl,
    prefix: config.redis.prefix + '.session:',
  };
  var settings = {
    store: new RedisStore(redisOptions),
    secret: config.session.salt,
    name: 'sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: config.redis.ttl * 1000 /* milliseconds for maxAge, not seconds */
    }
  };
  return session(settings);
};
