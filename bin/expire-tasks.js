#!/usr/bin/env node
var debug       = require('debug')('queue:bin:expire-tasks');
var base        = require('taskcluster-base');
var path        = require('path');
var Promise     = require('promise');
var _           = require('lodash');
var BlobStore   = require('../queue/blobstore');
var Bucket      = require('../queue/bucket');
var data        = require('../queue/data');
var taskcluster = require('taskcluster-client');
var assert      = require('assert');

/** Launch expire-tasks */
var launch = async function(profile) {
  debug("Launching with profile: %s", profile);

  // Load configuration
  var cfg = base.config({
    defaults:     require('../config/defaults'),
    profile:      require('../config/' + profile),
    envs: [
      'pulse_username',
      'pulse_password',
      'queue_publishMetaData',
      'taskcluster_credentials_clientId',
      'taskcluster_credentials_accessToken',
      'aws_accessKeyId',
      'aws_secretAccessKey',
      'azure_accountName',
      'azure_accountKey',
      'influx_connectionString'
    ],
    filename:     'taskcluster-queue'
  });

  // Create InfluxDB connection for submitting statistics
  var influx = new base.stats.Influx({
    connectionString:   cfg.get('influx:connectionString'),
    maxDelay:           cfg.get('influx:maxDelay'),
    maxPendingPoints:   cfg.get('influx:maxPendingPoints')
  });

  // Start monitoring the process
  base.stats.startProcessUsageReporting({
    drain:      influx,
    component:  cfg.get('queue:statsComponent'),
    process:    'expire-tasks'
  });

  // Create tasks table
  var Task = data.Task.setup({
    table:              cfg.get('queue:taskTableName'),
    credentials:        cfg.get('azure'),
    drain:              influx,
    component:          cfg.get('queue:statsComponent'),
    process:            'expire-tasks'
  });

  debug("Waiting for resources to be created");
  await Task.ensureTable();

  // Notify parent process, so that this worker can run using LocalApp
  base.app.notifyLocalAppInParentProcess();

  // Find an task expiration delay
  var delay = cfg.get('queue:taskExpirationDelay');
  var now   = taskcluster.fromNow(delay);
  assert(!_.isNaN(now), "Can't have NaN as now");

  // Expire tasks using delay
  debug("Expiring tasks at: %s, from before %s", new Date(), now);
  var count = await Task.expire(now);
  debug("Expired %s tasks", count);

  // Stop recording statistics and send any stats that we have
  base.stats.stopProcessUsageReporting();
  return influx.close();
};

// If expire-tasks.js is executed run launch
if (!module.parent) {
  // Find configuration profile
  var profile = process.argv[2];
  if (!profile) {
    console.log("Usage: expire-tasks.js [profile]")
    console.error("ERROR: No configuration profile is provided");
  }
  // Launch with given profile
  launch(profile).then(function() {
    debug("Expired tasks successfully");
    // Close the process we're done now
    process.exit(0);
  }).catch(function(err) {
    debug("Failed to start expire-tasks, err: %s, as JSON: %j",
          err, err, err.stack);
    // If we didn't launch the expire-tasks we should crash
    process.exit(1);
  });
}

// Export launch in-case anybody cares
module.exports = launch;