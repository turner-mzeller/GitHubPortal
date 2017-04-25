//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

'use strict';

const async = require('async');
const debug = require('debug')('azureossportal');
const utils = require('../utils');
const github = require('octonode');
const insights = require('./insights');

const Org = require('./org');
const Team = require('./team');
const User = require('./user');
const RedisHelper = require('./redis');

/*eslint no-console: ["error", { allow: ["warn"] }] */

function OpenSourceUserContext(options, callback) {
  var self = this;
  self.displayNames = {
    github: null,
    azure: null,
  };
  self.usernames = {
    github: null,
    azure: null,
  };
  self.avatars = {
    github: null,
  };
  self.id = {
    github: null,
  };
  self.entities = {
    link: null,
    primaryMembership: null,
  };
  self.tokens = {
    github: null,
    githubIncreasedScope: null,
  };
  const applicationConfiguration = options.config;
  const dataClient = options.dataClient;
  const redisInstance = options.redisClient;
  const link = options.link;
  this.insights = options.insights;
  if (this.insights === undefined) {
    this.insights = insights();
  }
  let modernUser;
  this.cache = {
    orgs: {},
    users: {},
  };
  this.modernUser = function () {
    return modernUser;
  };
  this.createModernUser = function (id, login) {
    modernUser = new User(this, id);
    modernUser.login = login;
    return modernUser;
  };
  this.setting = function (name) {
    return applicationConfiguration[name];
  };
  this.dataClient = function () {
    return dataClient;
  };
  this.redisClient = function () {
    return redisInstance;
  };
  this.safeConfiguration = safeSettings(applicationConfiguration);
  this.baseUrl = '/';
  if (applicationConfiguration && applicationConfiguration.redis) {
    this.redis = new RedisHelper(this, applicationConfiguration.redis.prefix);
  }
  if (link && options.request) {
    return callback(new Error('The context cannot be set from both a request and a link instance.'));
  }
  if (link) {
    return self.setPropertiesFromLink(link, callback);
  }
  if (options.request) {
    return this.resolveLinkFromRequest(options.request, callback);
  }
  callback(new Error('Could not initialize the context for the acting user.'), self);
}

OpenSourceUserContext.prototype.setPropertiesFromLink = function (link, callback) {
  this.usernames.github = link.ghu;
  this.id.github = link.ghid.toString();
  this.usernames.azure = link.aadupn;
  this.entities.link = link;
  this.displayNames.azure = link.aadname;
  this.avatars.github = link.ghavatar;
  this.tokens.github = link.githubToken;
  this.tokens.githubIncreasedScope = link.githubTokenIncreasedScope;
  var modernUser = this.modernUser();
  if (!modernUser && this.id.github) {
    modernUser = this.createModernUser(this.id.github, this.usernames.github);
  }
  modernUser.link = link;
  callback(null, this);
};

function tooManyLinksError(self, userLinks, callback) {
  const tooManyLinksError = new Error(`This account has ${userLinks.length} linked GitHub accounts.`);
  tooManyLinksError.links = userLinks;
  tooManyLinksError.tooManyLinks = true;
  return callback(tooManyLinksError, self);
}

function existingGitHubIdentityError(self, link, requestUser, callback) {
  const endUser = requestUser.azure.displayName || requestUser.azure.username;
  const authenticatedGitHubUsername = requestUser.github.username;
  const obfuscatedUsername = utils.obfuscate(link.ghu, Math.min(link.ghu.length / 2));
  const anotherGitHubAccountError = new Error(`${endUser}, there is a different GitHub account linked to your corporate identity.`);
  anotherGitHubAccountError.anotherAccount = true;
  anotherGitHubAccountError.skipLog = true;
  anotherGitHubAccountError.detailed = (
    `You've authenticated with the GitHub username of "${authenticatedGitHubUsername}", which is not the account that you have linked.</p>
    <p class="lead">If you need to switch which account is associated with your identity, please sign out of GitHub,
    come back to the portal to unlink the old account, and then continue with the new account.</p>

    <p class="lead">Your other GitHub account username ends in: ${obfuscatedUsername}.`);
  anotherGitHubAccountError.fancyLink = {
    link: '/signout/github/?redirect=github',
    title: `Sign Out ${requestUser.github.username} on GitHub`,
  };
  return callback(anotherGitHubAccountError, self);
}

// ----------------------------------------------------------------------------
// Populate the user's OSS context object.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.resolveLinkFromRequest = function (request, callback) {
  const self = this;
  const requestUser = request.user;
  if (requestUser && requestUser.github) {
    self.usernames.github = requestUser.github.username;
    self.id.github = requestUser.github.id;
    self.displayNames.github = requestUser.github.displayName;
    self.avatars.github = requestUser.github.avatarUrl;
  }
  if (requestUser && requestUser.azure) {
    self.usernames.azure = requestUser.azure.username;
    self.displayNames.azure = requestUser.azure.displayName;
  }
  if (self.setting('authentication').scheme === 'aad' && requestUser.azure && requestUser.azure.oid) {
    return self.dataClient().getUserByAadOid(requestUser.azure.oid, function (findError, userLinks) {
      if (findError) {
        return callback(utils.wrapError(findError, 'There was a problem trying to load the link for the active user.'), self);
      }
      if (userLinks.length === 0) {
        return callback(null, self);
      }
      if (userLinks.length > 1) {
        return tooManyLinksError(self, userLinks, callback);
      }
      const link = userLinks[0];
      if (requestUser.github && requestUser.github.username && link.ghu !== requestUser.github.username && link.ghid !== requestUser.github.id) {
        return existingGitHubIdentityError(self, link, requestUser, callback);
      }
      return self.setPropertiesFromLink(link, callback);
    });
  }
  let userObject;
  if (self.id.github) {
    userObject = self.createModernUser(self.id.github, self.usernames.github);
  }
  if (!userObject) {
    return callback(new Error('There\'s a logic bug in the user context object. We cannot continue.'), self);
  }
  userObject.getLink(function (error, link) {
    if (error) {
      return callback(utils.wrapError(error, 'We were not able to retrieve information about any link for your user account at this time.'), self);
    }
    if (link) {
      return self.setPropertiesFromLink(link, callback);
    } else {
      callback(null, self);
    }
  });
};

// ----------------------------------------------------------------------------
// SECURITY METHOD:
// Determine whether the authenticated user is an Administrator of the org. At
// this time there is a special "portal sudoers" team that is used. The GitHub
// admin flag is not used [any longer] for performance reasons to reduce REST
// calls to GitHub.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.isPortalAdministrator = function (callback) {
  /*
  var self = this;
  if (self.entities && self.entities.primaryMembership) {
      var pm = self.entities.primaryMembership;
      if (pm.role && pm.role === 'admin') {
          return callback(null, true);
      }
  }
  */
  this.org().getPortalSudoersTeam().isMember(function (error, isMember) {
    if (error) {
      return callback(utils.wrapError(error,
        'We had trouble querying GitHub for important team management ' +
        'information. Please try again later or report this issue.'));
    }
    callback(null, isMember === true);
  });
};

// ----------------------------------------------------------------------------
// Create a simple GitHub client. Should be audited, since using this library
// directly may result in methods which are not cached, etc.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.createGenericGitHubClient = function () {
  const ownerToken = this.org().setting('ownerToken');
  if (!ownerToken) {
    throw new Error('No "ownerToken" set for the ' + this.org().name + ' organization.');
  }
  return github.client(ownerToken);
};

// ----------------------------------------------------------------------------
// Make sure system links are loaded for a set of users.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.getLinksForUsers = function (list, callback) {
  const dc = this.dataClient();
  async.map(list, function (person, cb) {
    if (person && person.id) {
      cb(null, person.id);
    } else {
      cb(new Error('No ID known for this person instance.'));
    }
  }, function (error, map) {
    if (error) {
      return callback(error);
    }
    // In large organizations, we will have trouble getting this much data back
    // all at once.
    const groups = [];
    let j = 0;
    const perGroup = 200;
    let group = [];
    for (let i = 0; i < map.length; i++) {
      if (j++ == perGroup) {
        groups.push(group);
        group = [];
        j = 0;
      }
      group.push(map[i]);
    }
    if (group.length > 0) {
      groups.push(group);
      group = [];
    }
    async.each(groups, function (userGroup, cb) {
      dc.getUserLinks(userGroup, function (error, links) {
        if (error) {
          // Specific to problems we've had with storage results...
          if (error.headers && error.headers.statusCode && error.headers.body) {
            let oldError = error;
            error = new Error('Storage returned an HTTP ' + oldError.headers.statusCode + '.');
            error.innerError = oldError;
          }
          return cb(error);
        }
        for (let i = 0; i < list.length; i++) {
          list[i].trySetLinkInstance(links, true);
        }
        cb();
      });
    }, function (error) {
      callback(error ? error : null, error ? null : list);
    });
  });
};

// ----------------------------------------------------------------------------
// Translate a list of IDs into developed objects and their system links.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.getUsersAndLinksFromIds = function (list, callback) {
  const self = this;
  for (let i = 0; i < list.length; i++) {
    const id = list[i];
    list[i] = self.user(id);
  }
  self.getLinksForUsers(list, callback);
};

// ----------------------------------------------------------------------------
// Translate a hash of IDs to usernames into developed objects, system links
// and details loaded. Hash key is username, ID is the initial hash value.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.getCompleteUsersFromUsernameIdHash = function (hash, callback) {
  const self = this;
  const users = {};
  const list = [];
  for (const key in hash) {
    const id = hash[key];
    const username = key;
    const user = self.user(id);
    user.login = username;
    users[username] = user;
    list.push(user);
  }
  async.parallel([
    function (cb) {
      self.getLinksForUsers(list, cb);
    },
    function (cb) {
      async.each(list, function (user, innerCb) {
        user.getDetailsByUsername(function (/* formerUserError */) {
          // Ignore the user with an error... this means they left GitHub.
          // TODO: Should anything be done or reacted to in this scenario?
          innerCb();
        });
      }, function (error) {
        cb(error);
      });
    },
  ], function (error) {
    callback(error, users);
  });
};


// ----------------------------------------------------------------------------
// Retrieve all organizations that the user is a member of, if any.
// Caching: this set of calls can optionally turn off Redis caching, for use
// during onboarding.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.getMyOrganizations = function (allowCaching, callback) {
  const self = this;
  if (typeof allowCaching == 'function') {
    callback = allowCaching;
    allowCaching = true;
  }
  const orgs = [];
  async.each(self.orgs(), function (org, callback) {
    org.queryUserMembership(allowCaching, function (error, result) {
      let state = false;
      if (result && result.state) {
        state = result.state;
      }
      // Not sure how I feel about updating values on the org directly...
      org.membershipStateTemporary = state;
      orgs.push(org);
      callback(error);
    });
  }, function (/* ignoredError */) {
    callback(null, orgs);
  });
};

// ----------------------------------------------------------------------------
// Retrieve all of the teams -across all registered organizations. This is not
// specific to the user. This will include secret teams.
// Caching: the org.getTeams call has an internal cache at this time.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.getAllOrganizationsTeams = function (callback) {
  const self = this;
  async.concat(self.orgs(), function (org, cb) {
    org.getTeams(cb);
  }, function (error, teams) {
    if (error) {
      return callback(error);
    }
    // CONSIDER: SORT: Do these results need to be sorted?
    callback(null, teams);
  });
};

// ----------------------------------------------------------------------------
// This function uses heavy use of caching since it is an expensive set of
// calls to make to the GitHub API when the cache misses: N API calls for N
// teams in M organizations.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.getMyTeamMemberships = function (role, alternateUserId, callback) {
  const self = this;
  if (typeof alternateUserId == 'function') {
    callback = alternateUserId;
    alternateUserId = self.id.github;
  }
  this.getAllOrganizationsTeams(function (error, teams) {
    if (error) {
      return callback(error);
    }
    const myTeams = [];
    async.each(teams, function (team, callback) {
      team.getMembersCached(role, function (error, members) {
        if (error) {
          return callback(error);
        }
        for (let i = 0; i < members.length; i++) {
          const member = members[i];
          if (member.id == alternateUserId) {
            myTeams.push(team);
            break;
          }
        }
        callback();
      });
    }, function (error) {
      callback(error, myTeams);
    });
  });
};

// ----------------------------------------------------------------------------
// Designed for use by tooling, this returns the full set of administrators of
// teams across all orgs. Designed to help setup communication with the people
// using this portal for their daily engineering group work.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.getAllMaintainers = function (callback) {
  this.getAllOrganizationsTeams(function (getTeamsError, teams) {
    if (getTeamsError) {
      return callback(getTeamsError);
    }
    const users = {};
    async.each(teams, function (team, callback) {
      team.getMembersCached('maintainer', function (getTeamMembersError, members) {
        if (getTeamMembersError) {
          return callback(getTeamMembersError);
        }
        for (let i = 0; i < members.length; i++) {
          const member = members[i];
          if (users[member.id] === undefined) {
            users[member.id] = member;
          }
          // A dirty patch on top, just to save time now.
          if (users[member.id]._getAllMaintainersTeams === undefined) {
            users[member.id]._getAllMaintainersTeams = {};
          }
          users[member.id]._getAllMaintainersTeams[team.id] = team;
        }
        callback();
      });
    }, function (getMembersIterationError) {
      if (getMembersIterationError) {
        return callback(getMembersIterationError);
      }
      const asList = [];
      for (const key in users) {
        const user = users[key];
        asList.push(user);
      }
      async.each(asList, function (user, cb) {
        user.getLink(cb);
      }, function (getUserLinkError) {
        callback(getUserLinkError, asList);
      });
    });
  });
};


// ----------------------------------------------------------------------------
// Retrieve a set of team results.
// ----------------------------------------------------------------------------
// [_] CONSIDER: Cache/ Consider caching this sort of important return result...
OpenSourceUserContext.prototype.getTeamSet = function (teamIds, inflate, callback) {
  const self = this;
  if (typeof inflate === 'function') {
    callback = inflate;
    inflate = false;
  }
  const teams = [];
  async.each(teamIds, function (teamId, cb) {
    self.getTeam(teamId, inflate, function (error, team) {
      if (!error) {
        teams.push(team);
      }
      cb(error);
    });
  }, function (error) {
    // CONSIDER: SORT: Do these results need to be sorted?
    callback(error, teams);
  });
};

// ----------------------------------------------------------------------------
// Retrieve a single team instance. This version hydrates the team's details
// and also sets the organization instance.
// ----------------------------------------------------------------------------
// [_] CONSIDER: Cache/ Consider caching this sort of important return result...
OpenSourceUserContext.prototype.getTeam = function (teamId, callback) {
  const self = this;
  const team = createBareTeam(self, teamId);
  team.getDetails(function (error) {
    if (error) {
      error = utils.wrapError(error, 'There was a problem retrieving the details for the team. The team may no longer exist.');
    }
    callback(error, error ? null : team);
  });
};

// ----------------------------------------------------------------------------
// Prepare a list of all organization names, lowercased, from the original
// config instance.
// ----------------------------------------------------------------------------
function allOrgNamesLowercase(orgs) {
  const list = [];
  if (orgs && orgs.length) {
    for (let i = 0; i < orgs.length; i++) {
      const name = orgs[i].name;
      if (!name) {
        throw new Error('No organization name has been provided for one of the configured organizations.');
      }
      list.push(name.toLowerCase());
    }
  }
  return list;
}

// ----------------------------------------------------------------------------
// Retrieve an array of all organizations registered for management with this
// portal instance. Used for iterating through global operations. We'll need to
// use smart caching to land this experience better than in the past, and to
// preserve API use rates.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.orgs = function getAllOrgs() {
  const self = this;
  const allOrgNames = allOrgNamesLowercase(self.setting('organizations'));
  const orgs = [];
  for (let i = 0; i < allOrgNames.length; i++) {
    orgs.push(self.org(allOrgNames[i]));
  }
  return orgs;
};

// ----------------------------------------------------------------------------
// Retrieve a user-scoped elevated organization object via a static
// configuration lookup.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.org = function getOrg(orgNameAnycase) {
  if (orgNameAnycase === undefined || orgNameAnycase === '') {
    orgNameAnycase = this.setting('organizations')[0].name;
  }
  const name = orgNameAnycase.toLowerCase();
  if (this.cache.orgs[name]) {
    return this.cache.orgs[name];
  }
  let settings;
  const orgs = this.setting('organizations');
  for (let i = 0; i < orgs.length; i++) {
    if (orgs[i].name && orgs[i].name.toLowerCase() == name) {
      settings = orgs[i];
      break;
    }
  }
  if (!settings) {
    throw new Error('The requested organization "' + orgNameAnycase + '" is not currently available for actions or is not configured for use at this time.');
  }
  const tr = this.setting('corporate').trainingResources;
  if (tr && tr['onboarding-complete']) {
    const tro = tr['onboarding-complete'];
    const trainingResources = {
      corporate: tro.all,
      github: tro.github,
    };
    if (tro[name]) {
      trainingResources.organization = tro[name];
    }
    settings.trainingResources = trainingResources;
  }
  this.cache.orgs[name] = new Org(this, settings.name, settings);
  return this.cache.orgs[name];
};

// ----------------------------------------------------------------------------
// Retrieve an object representing the user, by GitHub ID.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.user = function getUser(id, optionalGitHubInstance) {
  const self = this;
  if (typeof id != 'string') {
    id = id.toString();
  }
  if (self.cache.users[id]) {
    return self.cache.users[id];
  } else {
    self.cache.users[id] = new User(self, id, optionalGitHubInstance);
    return self.cache.users[id];
  }
};

// ----------------------------------------------------------------------------
// Allows creating a team reference with just a team ID, no org instance.
// ----------------------------------------------------------------------------
function createBareTeam(oss, teamId) {
  const teamInstance = new Team(oss.org(), teamId, null);
  teamInstance.org = null;
  return teamInstance;
}

// ----------------------------------------------------------------------------
// Helper function for UI: Store in the user's session an alert message or
// action to be shown in another successful render. Contexts come from Twitter
// Bootstrap, i.e. 'success', 'info', 'warning', 'danger'.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.saveUserAlert = function (req, message, title, context, optionalLink, optionalCaption) {
  const alert = {
    message: message,
    title: title || 'FYI',
    context: context || 'success',
    optionalLink: optionalLink,
    optionalCaption: optionalCaption,
  };
  if (req.session) {
    if (req.session.alerts && req.session.alerts.length) {
      req.session.alerts.push(alert);
    } else {
      req.session.alerts = [
        alert,
      ];
    }
  }
};

function safeSettings(config) {
  if (config) {
    return config.obfuscatedConfig;
  }
}

// ----------------------------------------------------------------------------
// Helper function for UI: Render a view. By using our own rendering function,
// we can make sure that events such as alert views are still actually shown,
// even through redirect sequences.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.render = function (req, res, view, title, optionalObject) {
  if (typeof title == 'object') {
    optionalObject = title;
    title = '';
    debug('context::render: the provided title was actually an object');
  }
  const breadcrumbs = req.breadcrumbs;
  if (breadcrumbs && breadcrumbs.length && breadcrumbs.length > 0) {
    breadcrumbs[breadcrumbs.length - 1].isLast = true;
  }
  const authScheme = this.setting('authentication').scheme;
  const user = {
    primaryAuthenticationScheme: authScheme,
    primaryUsername: authScheme === 'github' ? this.usernames.github : this.usernames.azure,
    githubSignout: authScheme === 'github' ? '/signout' : '/signout/github',
    azureSignout: authScheme === 'github' ? '/signout/azure' : '/signout',
  };
  if (this.id.github || this.usernames.github) {
    user.github = {
      id: this.id.github,
      username: this.usernames.github,
      displayName: this.displayNames.github,
      avatarUrl: this.avatars.github,
      accessToken: this.tokens.github !== undefined,
      increasedScope: this.tokens.githubIncreasedScope !== undefined,
    };
  }
  if (this.usernames.azure) {
    user.azure = {
      username: this.usernames.azure,
      displayName: this.displayNames.azure,
    };
  }
  const obj = {
    title: title,
    config: this.safeConfiguration,
    serviceBanner: this.setting('serviceBanner'),
    user: user,
    ossLink: this.entities.link,
    showBreadcrumbs: true,
    breadcrumbs: breadcrumbs,
    sudoMode: req.sudoMode,
  };
  if (optionalObject) {
    utils.merge(obj, optionalObject);
  }
  if (req.session && req.session.alerts && req.session.alerts.length && req.session.alerts.length > 0) {
    const alerts = [];
    utils.merge(alerts, req.session.alerts);
    req.session.alerts = [];
    for (let i = 0; i < alerts.length; i++) {
      if (typeof alerts[i] == 'object') {
        alerts[i].number = i + 1;
      }
    }
    obj.alerts = alerts;
  }
  res.render(view, obj);
};

// ----------------------------------------------------------------------------
// Cheap breadcrumbs on a request object as it goes through our routes. Does
// not actually store anything in the OSS instance at this time.
// ----------------------------------------------------------------------------
OpenSourceUserContext.prototype.addBreadcrumb = function (req, breadcrumbTitle, optionalBreadcrumbLink) {
  utils.addBreadcrumb(req, breadcrumbTitle, optionalBreadcrumbLink);
};

module.exports = OpenSourceUserContext;
