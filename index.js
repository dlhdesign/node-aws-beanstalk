var fs = require('fs');
var AWS = require('aws-sdk');
var util = require( 'util' );
var extend = require('util')._extend;
var chalk = require( 'chalk' );
var defaultVersion = '1.0.0';

function pick(src, keys) {
  var ret = {};
  keys.forEach(function(key) {
    ret[key] = src[key];
    if (ret[key] === undefined) {
      delete ret[key];
    }
  });
  return ret;
}

function setup(config, codePackage) {
  var packageName, params;

  config.version = config.version !== undefined ? config.version : defaultVersion;
  params = {
    ApplicationName: config.appName,
    EnvironmentName: config.envName || config.appName + '-env',
    Description: config.description,
    VersionLabel: config.version,
    AutoCreateApplication: true,
    SolutionStackName: config.solutionStack,
    TemplateName: config.template,
    CNAMEPrefix: config.CNAMEPrefix,
    GroupName: config.GroupName,
    Tier: {
      Name: config.tier || 'WebServer',
      Type: config.tier === 'Worker' ? 'SQS/HTTP' : 'Standard',
      Version: '1.0'
    },
    Tags: config.environmentTags,
    OptionSettings: config.environmentSettings
  };
  if (codePackage) {
    packageName = codePackage.split('/');
    params.SourceBundle = {
      S3Bucket: (config.bucketConfig && config.bucketConfig.Bucket ? config.bucketConfig.Bucket : config.appName).toLowerCase(),
      S3Key: config.version + '-' + packageName[packageName.length - 1]
    };
  }

  return params;
}

function waitForEnv(beanstalk, params, status, logger, callback, count, start) {
  var maxTries = 80;
  if (!count) {
    logger('Waiting for environment "' + params.EnvironmentName + '"...');
  }
  start = start || +(new Date());
  count = count || 0;
  status = Array.isArray(status) ? status : [status];
  beanstalk.describeEnvironments(
    {
      ApplicationName: params.ApplicationName,
      EnvironmentNames: [params.EnvironmentName]
    },
    function(err, data) {
      var waitTime = (maxTries / 2) - (count * 2);
      if (waitTime < 2) {
        waitTime = 2;
      }
      if (err) {
        logger('beanstalk.describeEnvironments request failed. Check your AWS credentials and permissions.');
        callback(err);
      } else {
        if (data.Environments && data.Environments.length > 0) {
          if (status.indexOf(data.Environments[0].Status) === -1) {
            if (count >= maxTries) {
              logger('  "' + params.EnvironmentName + '" waited too long; aborting. Please manually clean up the environment and try again');
              callback(true);
            } else {
              logger('    "' + params.EnvironmentName + '" not one of [' + status + '] (currently ' + data.Environments[0].Status + '); next check in ' + waitTime + 'sec (attempt: ' + (count + 1) + '/' + maxTries + ')');
              setTimeout(function () {
                waitForEnv(beanstalk, params, status, logger, callback, count + 1, start);
              }, waitTime * 1000);
            }
          } else {
            logger('   "' + params.EnvironmentName + '" is ' + data.Environments[0].Status + '; Done (' + ((+(new Date) - start)/1000) + 'sec)');
            callback(err, data);
          }
        } else {
          logger('Environment "' + params.EnvironmentName + '" not found.');
          callback(true);
        }
      }
    }
  );
}

function updateEnvironment(beanstalk, params, logger, callback) {
  logger('Updating environment "' + params.EnvironmentName + '"...');
  beanstalk.updateEnvironment(
    pick(params,['EnvironmentName', 'Description', 'OptionSettings', 'SolutionStackName', 'TemplateName', 'VersionLabel', 'Tier', 'GroupName']),
    function(err, data) {
      if (err) {
        logger('Create environment failed.');
        callback(err);
      } else {
        logger('Environment "' + params.EnvironmentName + '" updated and is now being launched...');
        waitForEnv(beanstalk, params, 'Ready', logger, callback);
      }
    }
  );
};

function createApplicationVersion(beanstalk, params, logger, callback) {
  logger('Creating application version "' + params.VersionLabel + '"...');
  beanstalk.createApplicationVersion(
    pick(params,['ApplicationName', 'VersionLabel', 'Description', 'SourceBundle']),
    function(err, data) {
      if (err) {
        logger('Create application version failed.');
        callback(err);
      } else {
        logger('Version "' + params.VersionLabel + '" created.');
        callback(err, data);
      }
    }
  );
};

function createEnvironment(beanstalk, params, logger, callback, fast) {
  logger('Creating environment "' + params.EnvironmentName + '"...');
  beanstalk.createEnvironment(
    pick(params,['ApplicationName', 'EnvironmentName', 'Description', 'OptionSettings', 'SolutionStackName', 'TemplateName', 'VersionLabel', 'Tier', 'Tags', 'CNAMEPrefix', 'GroupName']),
    function(err, data) {
      if (err) {
        logger('Create environment failed.');
        callback(err);
      } else {
        logger('Environment "' + params.EnvironmentName + '" created and is now being launched...');
        if (fast === true) {
          logger('Environment "' + params.EnvironmentName + '": skipping wait');
          callback( err, {
            newRecord: true,
            data: data
          });
        } else {
          waitForEnv(beanstalk, params, 'Ready', logger, function ( err, data ) {
            callback( err, {
              newRecord: true,
              data: data
            });
          });
        }
      }
    }
  );
};

function terminateEnvironment(beanstalk, params, logger, callback) {
  logger('Terminating environment "' + params.EnvironmentName + '"...');
  waitForEnv(beanstalk, params, ['Terminated','Ready'], logger, function (err) {
    if (err) {
      callback(err);
    } else {
      beanstalk.terminateEnvironment(
        {
          EnvironmentName: params.EnvironmentName
        },
        function(err, data) {
          if (err) {
            logger('Terminate environment failed.');
            callback(err);
          } else {
            logger('Environment "' + params.EnvironmentName + '" is now being terminated...');
            waitForEnv(beanstalk, params, 'Terminated', logger, callback);
          }
        }
      );
    }
  });
};

function swapEnvironments(beanstalk, sourceName, destinationName, logger, callback) {
  logger('Swapping environments "' + sourceName + '" and "' + destinationName + '"...');
  beanstalk.swapEnvironmentCNAMEs(
    {
      SourceEnvironmentName: sourceName,
      DestinationEnvironmentName: destinationName
    },
    function(err, data) {
      if (err) {
        logger('Swap environments failed.');
        callback(err);
      } else {
        logger('Environments "' + sourceName + '" and "' + destinationName + '" swapped.');
        callback(err, data);
      }
    }
  );
};

function describeEnvironment(beanstalk, params, logger, callback, forSwap) {
  logger('Checking for environment "' + params.EnvironmentName + '"...');
  beanstalk.describeEnvironments(
    {
      ApplicationName: params.ApplicationName,
      EnvironmentNames: [params.EnvironmentName]
    },
    function(err, data) {
      var version;
      if (err) {
        logger('beanstalk.describeEnvironments request failed. Check your AWS credentials and permissions.');
        callback(err);
      } else {
        if (data.Environments && data.Environments.length > 0) {
          if (data.Environments[0].Status !== 'Ready' && !forSwap) {
            waitForEnv(beanstalk, params, 'Ready', logger, callback);
          } else {
            callback(err, data);
          }
        } else {
          params.VersionLabel = params.EnvironmentName + '-' + defaultVersion;
          createApplicationVersion(beanstalk, params, logger, function (err, data) {
            createEnvironment(beanstalk, params, logger, callback, true);
          });
        }
      }
    }
  );
};

function createApplication(beanstalk, params, logger, callback) {
  logger('Creating application "' + params.ApplicationName + '...');
  beanstalk.createApplication(
    pick(params,['ApplicationName', 'Description']),
    function(err, data) {
    if (err) {
      logger('Create application failed.');
      callback(err);
    } else {
      callback(err, data);
    }
  });
};

function describeApplication(beanstalk, params, logger, callback) {
  logger('Checking for application "' + params.ApplicationName + '"...');
  beanstalk.describeApplications(
    {
      ApplicationNames: [params.ApplicationName]
    },
    function(err, data) {
      if (err) {
        logger('beanstalk.describeApplication request failed. Check your AWS credentials and permissions.');
        callback(err);
      } else {
        if (data.Applications && data.Applications.length > 0) {
          callback(err, data);
        } else {
          createApplication(beanstalk, params, logger, callback);
        }
      }
    }
  );
};

function getLatestVersion(beanstalk, params, logger, callback) {
  logger('Getting latest application version for "' + params.ApplicationName + '"...');
  beanstalk.describeApplicationVersions(
    {
      ApplicationName: params.ApplicationName
    },
    function(err, data) {
      if (err) {
        logger('beanstalk.describeApplicationVersions request failed. Check your AWS credentials and permissions.');
        callback(err);
      } else {
        if (data.ApplicationVersions && data.ApplicationVersions.length > 0) {
          if (!data.ApplicationVersions.some(function (version) {
            if (version.VersionLabel.indexOf(params.envName) > -1) {
              callback(err, version.VersionLabel);
              return true;
            }
          })) {
            callback(err, null);
          }
        } else {
          callback(err, null);
        }
      }
    }
  );
};

function uploadCode(S3, params, codePackage, logger, callback) {
  logger('Preparing to upload code to S3 bucket "' + params.SourceBundle.S3Bucket + '"...');
  fs.readFile(codePackage, function(err, data) {
    if (err) {
      return callback('Error reading specified package "'+ codePackage + '"');
    }
    logger('Uploading code to S3 bucket "' + params.SourceBundle.S3Bucket + '"...');
    S3.upload(
      {
        Bucket: params.SourceBundle.S3Bucket,
        Key: params.SourceBundle.S3Key,
        Body: data,
        ContentType: 'binary/octet-stream'
      },
      function(err, data) {
        if (err) {
          logger('Upload of "' + codePackage + '" to S3 bucket failed.');
          callback(err);
        } else {
          logger('Uploading code to S3 bucket "' + params.SourceBundle.S3Bucket + '" done.');
          callback(err, data);
        }
      }
    );
  });
};

function createBucket(S3, config, params, logger, callback) {
  var args = {};
  extend(args, config.bucketConfig || {});
  args.Bucket = params.SourceBundle.S3Bucket;
  logger('Creating S3 bucket "' + args.Bucket + '"...');
  S3.createBucket(
    args,
    function(err, bucketData) {
      if (err) {
        logger('Create S3 bucket "' + args.Bucket + '" failed.');
        callback(err);
      } else {
        S3.waitFor('bucketExists', {
          Bucket: args.Bucket
        }, function (err) {
          if (err) {
            logger('Create S3 bucket "' + args.Bucket + '" failed.');
            callback(err);
          } else {
            updateBucketTags(S3, config, params, logger, function(err) {
              callback(err, bucketData);
            });
          }
        });
      }
    }
  );
};

function updateBucketTags(S3, config, params, logger, callback) {
  if (config.bucketTags) {
    logger('Updating S3 bucket tags for "' + params.SourceBundle.S3Bucket + '"...');
    S3.putBucketTagging({
      Bucket: params.SourceBundle.S3Bucket,
      Tagging: {
        TagSet: config.bucketTags
      }
    }, function (err, data) {
      if (err) {
        logger('Adding tags to S3 bucket "' + params.SourceBundle.S3Bucket + '" failed.');
        callback(err);
      } else {
        logger('Adding tags to S3 bucket "' + params.SourceBundle.S3Bucket + '" done.');
        S3.waitFor('bucketExists', {
          Bucket: params.SourceBundle.S3Bucket
        }, callback);
      }
    });
  } else {
    callback(null, null);
  }
};

function updateBucket(S3, config, params, logger, callback) {
  var args = {};
  if (config.bucketConfig) {
    extend(args, config.bucketConfig || {});
    args.Bucket = params.SourceBundle.S3Bucket;
    logger('Updating S3 bucket "' + args.Bucket + '"...');
    S3.putBucketAcl(
      args,
      function(err, bucketData) {
        if (err) {
          logger('Updating S3 bucket "' + args.Bucket + '" failed.');
          callback(err);
        } else {
          updateBucketTags(S3, config, params, logger, function (err) {
            callback(err, bucketData);
          });
        }
      }
    );
  } else {
    updateBucketTags(S3, config, params, logger, callback);
  }
};

function getBucket(S3, config, params, logger, callback) {
  logger('Checking for S3 bucket "' + params.SourceBundle.S3Bucket + '"...');
  S3.headBucket(
    {
      Bucket: params.SourceBundle.S3Bucket
    },
    function(err, data) {
      if (err) {
        if (err.statusCode === 404) {
          createBucket(S3, config, params, logger, callback);
        } else {
          logger('S3.headBucket request failed. Check your AWS credentials and permissions.');
          callback(err);
        }
      } else {
        updateBucket(S3, config, params, logger, function(err) {
          callback(err, data);
        });
      }
    }
  );
};

exports.deploy = function(codePackage, config, callback, logger, beanstalk, S3) {
  var params,
      newEnvironment = false;

  if (!logger) {
    logger = function (msg) {
      console.log( util.format( '[%s] %s', chalk.green( params.ApplicationName + '[' + params.EnvironmentName + ']' ), msg ) );
    };
  }

  if(!beanstalk || !S3) {
    if("profile" in config) {
      var credentials = new AWS.SharedIniFileCredentials({profile: config.profile});
      AWS.config.credentials = credentials;
    }

    if (process.env.HTTPS_PROXY) {
      if (!AWS.config.httpOptions) {
        AWS.config.httpOptions = {};
      }
      var HttpsProxyAgent = require('https-proxy-agent');
      AWS.config.httpOptions.agent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
    }
  }
  if (!beanstalk) {
    beanstalk = new AWS.ElasticBeanstalk({
      region: config.region,
      accessKeyId: 'accessKeyId' in config ? config.accessKeyId : '',
      secretAccessKey: 'secretAccessKey' in config ? config.secretAccessKey : ''
    });
  }
  if (!S3) {
    S3 = new AWS.S3({
      region: config.region,
      accessKeyId: 'accessKeyId' in config ? config.accessKeyId : '',
      secretAccessKey: 'secretAccessKey' in config ? config.secretAccessKey : ''
    });
  }
  params = setup(config, codePackage);

  if (!params.SolutionStackName && !params.TemplateName) {
    return callback('Missing either "solutionStack" or "template" config');
  }
  if (params.SolutionStackName && params.TemplateName) {
    return callback('Provided both "solutionStack" and "template" config; only one or the other supported');
  }
  if (!params.SourceBundle) {
    return callback('Missing/invalid codePackage');
  }

  getBucket(S3, config, params, logger, function (err, data) {
    if (err) {
      callback(err);
    } else {
      uploadCode(S3, params, codePackage,logger, function (err, data) {
        if (err) {
          callback(err);
        } else {
          describeApplication(beanstalk, params, logger, function (err, data) {
            if (err) {
              callback(err);
            } else {
              describeEnvironment(beanstalk, params, logger, function (err, data) {
                if (err) {
                  callback(err);
                } else {
                  if ( data && data.newRecord ) {
                    callback();
                  } else {
                    getLatestVersion(beanstalk, params, logger, function (err, data ) {
                      var version;
                      if (err) {
                        callback(err);
                      } else {
                        version = (data || params.VersionLabel).split('.');
                        if (version.length > 3) {
                          version[version.length - 1] = parseInt(version[version.length - 1]) + 1;
                        } else {
                          version.push(0);
                        }
                        params.VersionLabel = params.EnvironmentName + '-' + version.join('.');
                        createApplicationVersion(beanstalk, params, logger, function (err, data) {
                          var swapName = 'tmp-' + (+new Date());
                          if (err) {
                            callback(err);
                          } else {
                            if (newEnvironment) {
                              callback();
                            } else {
                              if (params.Tags || config.abswap === true) {
                                swap(beanstalk, params, logger, params.EnvironmentName, swapName, function (err, data) {
                                  if (err) {
                                    callback(err);
                                  } else {
                                    swap(beanstalk, params, logger, swapName, params.EnvironmentName, function (err, data) {
                                      if (err) {
                                        callback(err);
                                      } else {
                                        callback();
                                      }
                                    });
                                  }
                                });
                              } else {
                                updateEnvironment(beanstalk, params, logger, function (err, data) {
                                  if (err) {
                                    callback(err);
                                  } else {
                                    callback();
                                  }
                                });
                              }
                            }
                          }
                        });
                      }
                    });
                  }
                }
              }, params.Tags || config.abswap === true);
            }
          });
        }
      });
    }
  });
};

function swap(beanstalk, params, logger, from, to, callback) {
  params.EnvironmentName = to;
  createEnvironment(beanstalk, params, logger, function (err, data) {
    if (err) {
      callback(err);
    } else {
      if (params.Tier.Name === 'WebServer') {
        swapEnvironments(beanstalk, from, params.EnvironmentName, logger, function (err, data) {
          if (err) {
            callback(err);
          } else {
            params.EnvironmentName = from
            terminateEnvironment(beanstalk, params, logger, function (err, data) {
              if (err) {
                callback(err);
              } else {
                callback(err, data);
              }
            });
          }
        });
      } else {
        params.EnvironmentName = from;
        terminateEnvironment(beanstalk, params, logger, function (err, data) {
          if (err) {
            callback(err);
          } else {
            callback(err, data);
          }
        });
      }
    }
  });
}

exports.update = function(config, callback, logger, beanstalk) {
  var params;

  if (!logger) {
    logger = function (msg) {
      console.log( util.format( '[%s] %s', chalk.green( params.ApplicationName + '[' + params.EnvironmentName + ']' ), msg ) );
    };
  }

  if(!beanstalk) {
    if("profile" in config) {
      var credentials = new AWS.SharedIniFileCredentials({profile: config.profile});
      AWS.config.credentials = credentials;
    }

    if (process.env.HTTPS_PROXY) {
      if (!AWS.config.httpOptions) {
        AWS.config.httpOptions = {};
      }
      var HttpsProxyAgent = require('https-proxy-agent');
      AWS.config.httpOptions.agent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
    }
  }
  if (!beanstalk) {
    beanstalk = new AWS.ElasticBeanstalk({
      region: config.region,
      accessKeyId: 'accessKeyId' in config ? config.accessKeyId : '',
      secretAccessKey: 'secretAccessKey' in config ? config.secretAccessKey : ''
    });
  }
  if (config.S3Bucket) {
    logger('  DEPRECATION NOTICE: "S3Bucket" configuration is deprecated. Pleae use "bucketConfig.Bucket"');
    config.bucketConfig = config.bucketConfig || {};
    config.bucketConfig.Bucket = config.bucketConfig.Bucket || config.S3Bucket;
    delete config.S3Bucket;
  }
  params = setup(config);

  if (!params.SolutionStackName && !params.TemplateName) {
    return callback('Missing either "solutionStack" or "template" config');
  }
  if (params.SolutionStackName && params.TemplateName) {
    return callback('Provided both "solutionStack" and "template" config; only one or the other supported');
  }

  describeApplication(beanstalk, params, logger, function (err, data) {
    if (err) {
      callback(err);
    } else {
      describeEnvironment(beanstalk, params, logger, function (err, data) {
        var swapName = 'tmp-' + (+new Date());
        if (err) {
          callback(err);
        } else {
          if (params.Tags || config.abswap === true) {
            getLatestVersion(beanstalk, params, logger, function (err, data ) {
              params.VersionLabel = data || params.VersionLabel + '.0';
              swap(beanstalk, params, logger, params.EnvironmentName, swapName, function (err, data) {
                if (err) {
                  callback(err);
                } else {
                  swap(beanstalk, params, logger, swapName, params.EnvironmentName, function (err, data) {
                    if (err) {
                      callback(err);
                    } else {
                      callback();
                    }
                  });
                }
              });
            });
          } else {
            params.VersionLabel = data.Environments[0].VersionLabel;
            updateEnvironment(beanstalk, params, logger, function (err, data) {
              if (err) {
                callback(err);
              } else {
                callback();
              }
            });
          }
        }
      }, params.Tags || config.abswap === true);
    }
  });
};
