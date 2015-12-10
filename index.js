var fs = require('fs');
var AWS = require('aws-sdk');
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
    EnvironmentName: config.appName + '-env',
    Description: config.description,
    VersionLabel: config.version + '.0',
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
      S3Bucket: (config.S3Bucket ? config.S3Bucket : config.appName).toLowerCase(),
      S3Key: config.version + '-' + packageName[packageName.length - 1]
    };
  }

  return params;
}

function waitForEnv(beanstalk, params, status, logger, callback, count) {
  if (!count) {
    logger('Waiting for environment "' + params.EnvironmentName + '"...');
  }
  count = count || 0;
  beanstalk.describeEnvironments(
    {
      ApplicationName: params.ApplicationName,
      EnvironmentNames: [params.EnvironmentName]
    },
    function(err, data) {
      var waitTime = ((30 - (count * 2)) || 2);
      if (err) {
        logger('beanstalk.describeEnvironments request failed. Check your AWS credentials and permissions.');
        callback(err);
      } else {
        if (data.Environments && data.Environments.length > 0) {
          if (data.Environments[0].Status !== status) {
            if (count >= 50) {
              logger('  Waited too long; aborting. Please manually clean up the environment and try again');
              callback(true);
            } else {
              logger('    Not ' + status + ' (currently ' + data.Environments[0].Status + '); next check in ' + waitTime + 'sec (attempt: ' + (count + 1) + '/50)');
              setTimeout(function () {
                waitForEnv(beanstalk, params, status, logger, callback, count + 1);
              }, waitTime * 1000);
            }
          } else {
            logger('   Environment is ' + status + '; Done');
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

function createEnvironment(beanstalk, params, logger, callback) {
  logger('Creating environment "' + params.EnvironmentName + '"...');
  beanstalk.createEnvironment(
    pick(params,['ApplicationName', 'EnvironmentName', 'Description', 'OptionSettings', 'SolutionStackName', 'TemplateName', 'VersionLabel', 'Tier', 'Tags', 'CNAMEPrefix', 'GroupName']),
    function(err, data) {
      if (err) {
        logger('Create environment failed.');
        callback(err);
      } else {
        logger('Environment "' + params.EnvironmentName + '" created and is now being launched...');
        waitForEnv(beanstalk, params, 'Ready', logger, callback);
      }
    }
  );
};

function terminateEnvironment(beanstalk, params, logger, callback) {
  logger('Terminating environment "' + params.EnvironmentName + '"...');
  waitForEnv(beanstalk, params, 'Ready', logger, function (err) {
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

function describeEnvironment(beanstalk, params, logger, callback) {
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
          if (data.Environments[0].Status !== 'Ready') {
            waitForEnv(beanstalk, params, 'Ready', logger, callback);
          } else {
            callback(err, data);
          }
        } else {
          createEnvironment(beanstalk, params, logger, callback);
        }
      }
    }
  );
};

function createApplication(beanstalk, params, logger, callback) {
  logger('Creating application "' + params.ApplicationName + '" version "' + params.VersionLabel + '"...');
  beanstalk.createApplicationVersion(
    pick(params,['ApplicationName', 'Description', 'AutoCreateApplication', 'VersionLabel', 'SourceBundle']),
    function(err, data) {
    if (err) {
      logger('Create application version failed.');
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

function uploadCode(S3, params, codePackage, logger, callback) {
  logger('Uploading code to S3 bucket "' + params.SourceBundle.S3Bucket + '"...');
  fs.readFile(codePackage, function(err, data) {
    if(err) {
      return callback('Error reading specified package "'+ codePackage + '"');
    }
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
          callback(err, data);
        }
      }
    );
  });
};

function createBucket(S3, params, logger, callback) {
  logger('Creating S3 bucket "' + params.SourceBundle.S3Bucket + '"...');
  S3.createBucket(
    {
      Bucket: params.SourceBundle.S3Bucket
    },
    function(err, data) {
      if (err) {
        logger('Create S3 bucket "' + params.Bucket + '" failed.');
        callback(err);
      } else {
        callback(err, data);
      }
    }
  );
};

function getBucket(S3, params, logger, callback) {
  logger('Checking for S3 bucket "' + params.SourceBundle.S3Bucket + '"...');
  S3.headBucket(
    {
      Bucket: params.SourceBundle.S3Bucket
    },
    function(err, data) {
      if (err) {
        if (err.statusCode === 404) {
          createBucket(S3, params, logger, callback);
        } else {
          logger('S3.headBucket request failed. Check your AWS credentials and permissions.');
          callback(err);
        }
      } else {
        callback(err, data);
      }
    }
  );
};

exports.deploy = function(codePackage, config, callback, logger, beanstalk, S3) {
  var params;

  if (!logger) {
    logger = console.log;
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

  getBucket(S3, params, logger, function (err, data) {
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
                var version;
                if (err) {
                  callback(err);
                } else {
                  version = data.Environments[0].VersionLabel.split('.');
                  if (version.length > 3) {
                    version[version.length - 1] = parseInt(version[version.length - 1]) + 1;
                  } else {
                    version.push(0);
                  }
                  params.VersionLabel = version.join('.');
                  createApplicationVersion(beanstalk, params, logger, function (err, data) {
                    if (err) {
                      callback(err);
                    } else {
                      updateEnvironment(beanstalk, params, logger, function (err, data) {
                        if (err) {
                          callback(err);
                        } else {
                          callback();
                        }
                      });
                    }
                  });
                }
              });
            }
          });
        }
      });
    }
  });
};

exports.update = function(config, callback, logger, beanstalk) {
  var params;

  if (!logger) {
    logger = console.log;
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
  params = setup(config);

  if (!params.SolutionStackName && !params.TemplateName) {
    return callback('Missing either "solutionStack" or "template" config');
  }
  if (params.SolutionStackName && params.TemplateName) {
    return callback('Provided both "solutionStack" and "template" config; only one or the other supported');
  }

  function swap(from, to, callback) {
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
          params.EnvironmentName = from
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

  describeApplication(beanstalk, params, logger, function (err, data) {
    if (err) {
      callback(err);
    } else {
      describeEnvironment(beanstalk, params, logger, function (err, data) {
        var swapName = 'tmp-' + (+new Date());
        if (err) {
          callback(err);
        } else {
          params.VersionLabel = data.Environments[0].VersionLabel;
          if (params.Tags) {
            swap(params.EnvironmentName, swapName, function (err, data) {
              if (err) {
                callback(err);
              } else {
                swap(swapName, params.EnvironmentName, function (err, data) {
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
      });
    }
  });
};
