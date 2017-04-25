//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

'use strict';

const passport = require('passport');
const serializer = require('./passport/serializer');
const GitHubStrategy = require('passport-github').Strategy;
const OIDCStrategy = require('passport-azure-ad').OIDCStrategy;

// FYI: GitHub does not provide refresh tokens

function githubResponseToSubset(accessToken, refreshToken, profile, done) {
  let subset = {
    github: {
      accessToken: accessToken,
      displayName: profile.displayName,
      avatarUrl: profile._json && profile._json.avatar_url ? profile._json.avatar_url : undefined,
      id: profile.id,
      username: profile.username,
    },
  };
  return done(null, subset);
}

function githubResponseToIncreasedScopeSubset(accessToken, refreshToken, profile, done) {
  let subset = {
    githubIncreasedScope: {
      accessToken: accessToken,
      id: profile.id,
      username: profile.username,
    },
  };
  return done(null, subset);
}

function activeDirectorySubset(iss, sub, profile, accessToken, refreshToken, done) {
  // CONSIDER: TODO: Hybrid tenant checks.
  let subset = {
    azure: {
      displayName: profile.displayName,
      oid: profile._json.oid,
      username: profile._json.upn,
      accessToken: accessToken,
      refreshToken: refreshToken,
      exp: profile._json.exp,
    },
  };
  done(null, subset);
}

module.exports = function (app, config) {
  if (!config.authentication.scheme) {
    config.authentication.scheme = 'github';
  }
  if (config.authentication.scheme !== 'github' && config.authentication.scheme !== 'aad') {
    throw new Error(`Unsupported primary authentication scheme type "${config.authentication.scheme}"`);
  }

  // ----------------------------------------------------------------------------
  // GitHub Passport session setup.
  // ----------------------------------------------------------------------------
  let githubOptions = {
    clientID: config.github.clientId,
    clientSecret: config.github.clientSecret,
    callbackURL: config.github.callbackUrl,
    scope: [],
    userAgent: 'passport-azure-oss-portal-for-github' // CONSIDER: User agent should be configured.
  };
  let githubPassportStrategy = new GitHubStrategy(githubOptions, githubResponseToSubset);
  let aadStrategy = new OIDCStrategy({
    callbackURL: config.activeDirectory.redirectUrl,
    realm: config.activeDirectory.tenantId,
    clientID: config.activeDirectory.clientId,
    clientSecret: config.activeDirectory.clientSecret,
    oidcIssuer: config.activeDirectory.issuer,
    identityMetadata: 'https://login.microsoftonline.com/' + config.activeDirectory.tenantId + '/.well-known/openid-configuration',
    skipUserProfile: true,
    responseType: 'id_token code',
    responseMode: 'form_post',
    validateIssuer: true,
  }, activeDirectorySubset);

  // Validate the borrow some parameters from the GitHub passport library
  if (githubPassportStrategy._oauth2 && githubPassportStrategy._oauth2._authorizeUrl) {
    app.set('runtime/passport/github/authorizeUrl', githubPassportStrategy._oauth2._authorizeUrl);
  } else {
    throw new Error('The GitHub Passport strategy library may have been updated, it no longer contains the expected Authorize URL property within the OAuth2 object.');
  }
  if (githubPassportStrategy._scope && githubPassportStrategy._scopeSeparator) {
    app.set('runtime/passport/github/scope', githubPassportStrategy._scope.join(githubPassportStrategy._scopeSeparator));
  } else {
    throw new Error('The GitHub Passport strategy library may have been updated, it no longer contains the expected Authorize URL property within the OAuth2 object.');
  }

  passport.use('github', githubPassportStrategy);
  passport.use('azure-active-directory', aadStrategy);

  // ----------------------------------------------------------------------------
  // Expanded OAuth-scope GitHub access for org membership writes.
  // ----------------------------------------------------------------------------
  let expandedGitHubScopeStrategy = new GitHubStrategy({
    clientID: config.github.clientId,
    clientSecret: config.github.clientSecret,
    callbackURL: config.github.callbackUrl + '/increased-scope',
    scope: ['write:org'],
    userAgent: 'passport-azure-oss-portal-for-github' // CONSIDER: User agent should be configured.
  }, githubResponseToIncreasedScopeSubset);

  passport.use('expanded-github-scope', expandedGitHubScopeStrategy);

  app.use(passport.initialize());
  app.use(passport.session());

  const serializerOptions = {
    config: config,
    keyResolver: app.get('keyEncryptionKeyResolver'),
  };

  passport.serializeUser(serializer.serialize(serializerOptions));
  passport.deserializeUser(serializer.deserialize(serializerOptions));
  serializer.initialize(serializerOptions, app);

  return passport;
};
