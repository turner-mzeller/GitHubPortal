//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

'use strict';

// Status: Partial Functionality
// This module wraps a table service client to provide encryption and decryption trying
// to reuse existing helper code. It only wraps what is needed for this library to work.

// ----------------------------------------------------------------------------
// This is a Node.js implementation of client-side table entity encryption,
// compatible with the official Azure storage .NET library.
// ----------------------------------------------------------------------------

const async = require('async');
const encryption = require('./encryption');

function retrieveEntity() {
  const args = Array.prototype.slice.call(arguments);
  const tableClient = args.shift();
  const encryptionOptions = args.shift();
  // args[0] is the tableName;
  const partitionKey = args[1];
  const rowKey = args[2];
  const callback = args.pop();
  args.push((error, result, response) => {
    if (error) {
      return callback(error);
    }
    const reducedEntity = encryptionOptions.tableDehydrator(result);
    encryption.decryptEntity(partitionKey, rowKey, reducedEntity, encryptionOptions, (decryptError, entity) => {
      if (decryptError) {
        return callback(decryptError);
      }
      const hydrated = encryptionOptions.tableRehydrator(partitionKey, rowKey, entity);
      return callback(null, hydrated, response);
    });
  });
  tableClient.retrieveEntity.apply(tableClient, args);
}

function queryEntitiesCallback(encryptionOptions, callback, error, results, headers) {
  if (error) {
    error.headers = headers;
    return callback(error);
  }
  if (!(results && results.entries && results.entries.length > 0)) {
    return callback(null, results, headers);
  }
  const entities = results.entries;
  async.map(entities, (row, next) => {
    if (row === undefined || row.PartitionKey === undefined || row.PartitionKey._ === undefined) {
      return next(new Error('Entity does not have a PartitionKey.'));
    }
    if (row === undefined || row.RowKey === undefined || row.RowKey._ === undefined) {
      return next(new Error('Entity does not have a RowKey.'));
    }
    const partitionKey = row.PartitionKey._;
    const rowKey = row.RowKey._;
    let reducedEntity = null;
    try {
      reducedEntity = encryptionOptions.tableDehydrator(row);
    } catch (rex) {
      return next(rex);
    }
    encryption.decryptEntity(partitionKey, rowKey, reducedEntity, encryptionOptions, (decryptError, entity) => {
      if (decryptError) {
        return next(decryptError);
      }
      const hydrated = encryptionOptions.tableRehydrator(partitionKey, rowKey, entity);
      return next(null, hydrated);
    });
  }, (asyncError, decryptedRows) => {
    if (asyncError) {
      return callback(asyncError);
    }
    results.entries = decryptedRows;
    return callback(null, results);
  });
}

function queryEntities() {
  const args = Array.prototype.slice.call(arguments);
  const tableClient = args.shift();
  const encryptionOptions = args.shift();
  const callback = args.pop();
  args.push(queryEntitiesCallback.bind(undefined, encryptionOptions, callback));
  tableClient.queryEntities.apply(tableClient, args);
}

function insertEntity() {
  const args = Array.prototype.slice.call(arguments);
  const tableClient = args.shift();
  const encryptionOptions = args.shift();
  const entity = args[1];
  const partitionKey = entity.PartitionKey._;
  const rowKey = entity.RowKey._;
  const reducedEntity = encryptionOptions.tableDehydrator(entity);
  const callback = args[args.length - 1];
  encryption.encryptEntity(partitionKey, rowKey, reducedEntity, encryptionOptions, (encryptError, encryptedEntity) => {
    if (encryptError) {
      return callback(encryptError);
    }
    args[1] /* entity */ = encryptionOptions.tableRehydrator(partitionKey, rowKey, encryptedEntity);
    tableClient.insertEntity.apply(tableClient, args);
  });
}

function replaceEntity() {
  const args = Array.prototype.slice.call(arguments);
  const tableClient = args.shift();
  const encryptionOptions = args.shift();
  const entity = args[1];
  const partitionKey = entity.PartitionKey._;
  const rowKey = entity.RowKey._;
  const reducedEntity = encryptionOptions.tableDehydrator(entity);
  const callback = args[args.length - 1];
  encryption.encryptEntity(partitionKey, rowKey, reducedEntity, encryptionOptions, (encryptError, encryptedEntity) => {
    if (encryptError) {
      return callback(encryptError);
    }
    args[1] /* entity */ = encryptionOptions.tableRehydrator(partitionKey, rowKey, encryptedEntity);
    tableClient.replaceEntity.apply(tableClient, args);
  });
}

function mergeEntity() {
  const args = Array.prototype.slice.call(arguments);
  const callback = args.pop();
  return callback(new Error('Entity merge operations are not supported when using table encryption.'));
}

module.exports = function wrapTableClient(tableClient, encryptionOptions) {
  const wrapped = {
    insertEntity: insertEntity.bind(undefined, tableClient, encryptionOptions),
    mergeEntity: mergeEntity.bind(undefined, tableClient, encryptionOptions),
    queryEntities: queryEntities.bind(undefined, tableClient, encryptionOptions),
    replaceEntity: replaceEntity.bind(undefined, tableClient, encryptionOptions),
    retrieveEntity: retrieveEntity.bind(undefined, tableClient, encryptionOptions),
  };
  const passthru = [
    'createTableIfNotExists',
    'deleteEntity',
  ];
  for (let i = 0; i < passthru.length; i++) {
    const name = passthru[i];
    wrapped[name] = tableClient[name].bind(tableClient);
  }
  return wrapped;
};
