var fs = require('fs');
var AWS = require('aws-sdk');
var packageConfig = require('../../package.json');

exports.deploy = function(codePackage, config, callback, logger, beanstalk, S3) {

  var pick = function(src, keys) {
    var ret = {};
    keys.forEach(function(key) {
      ret[key] = src[key];
      if (ret[key] === undefined) {
        delete ret[key];
      }
    });
    return ret;
  }

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

  config.version = config.version !== undefined ? config.version : packageConfig.version;
  var params = {
    ApplicationName: config.appName,
    EnvironmentName: config.appName + '-env',
    Description: config.description,
    VersionLabel: config.version,
    SourceBundle: {
      S3Bucket: config.S3Bucket !== undefined ? config.S3Bucket : config.appName,
      S3Key: config.version + '-' + codePackage
    },
    AutoCreateApplication: true,
    SolutionStackName: config.solutionStack,
    TemplateName: config.template,
    Tier: {
      Name: config.tier || 'WebServer',
      Type: config.tier === 'Worker' ? 'SQS/HTTP' : 'Standard',
      Version: '1.0'
    },
    Tags: config.environmentTags,
    OptionSettings: config.environmentSettings
  };

  if (!params.SolutionStackName && !params.TemplateName) {
    return callback('Missing either "solutionStack" or "template" config');
  }
  if (params.SolutionStackName && params.TemplateName) {
    return callback('Provided both "solutionStack" and "template" config; only one or the other supported');
  }

  var createEnvironment = function(callback) {
    logger('Creating environment "' + params.EnvironmentName + '"...');
    beanstalk.createEnvironment(
      pick(params,['ApplicationName', 'EnvironmentName', 'Description', 'OptionSettings', 'SolutionStackName', 'TemplateName', 'VersionLabel', 'Tier', 'Tags']),
        function(err, data) {
        if (err) {
          logger('Create environment failed. Check your iam:PassRole permissions.');
          callback(err);
        } else {
          logger('Environment "' + params.EnvironmentName + '" created and is now being launched.');
          callback();
        }
      }
    );
  };

  var updateEnvironment = function(callback) {
    logger('Updating environment "' + params.EnvironmentName + '"...');
    beanstalk.updateEnvironment(
      pick(params,['EnvironmentName', 'Description', 'OptionSettings', 'SolutionStackName', 'TemplateName', 'VersionLabel', 'Tier']),
      function(err, data) {
        if (err) {
          logger('Create environment failed. Check your iam:PassRole permissions.');
          callback(err);
        } else {
          logger('Environment "' + params.EnvironmentName + '" updated and is now being launched.');
          callback();
        }
      }
    );
  };

  var describeEnvironment = function(callback) {
    logger('Checking for environment "' + params.EnvironmentName + '"...');
    beanstalk.describeEnvironments(
      {
        ApplicationName: params.ApplicationName,
        EnvironmentNames: [params.EnvironmentName]
      },
      function(err, data) {
        if (err) {
          logger('beanstalk.describeApplication request failed. Check your AWS credentials and permissions.');
          callback(err);
        } else {
          if (data.Environments && data.Environments.length > 0) {
            if (data.Environments[0].Status !== 'Ready') {
              logger('Environment is currently not in "Ready" status (currently "' + data.Environments[0].Status + '"). Please resolve/wait and try again.');
              callback();
            } else {
              updateEnvironment(callback);
            }
          } else {
            createEnvironment(callback);
          }
        }
      }
    );
  };

  var createApplication = function(callback) {
    logger('Creating application "' + params.ApplicationName + '" version "' + params.VersionLabel + '"...');
    beanstalk.createApplicationVersion(
      pick(params,['ApplicationName', 'Description', 'AutoCreateApplication', 'VersionLabel', 'SourceBundle']),
      function(err, data) {
      if (err) {
        logger('Create application version failed. Check your iam:PassRole permissions.');
        callback(err);
      } else {
        describeEnvironment(callback);
      }
    });
  };

  var describeApplication = function(callback) {
    logger('Checking for application "' + params.ApplicationName + '" version "' + params.VersionLabel + '"...');
    beanstalk.describeApplicationVersions(
      {
        ApplicationName: params.ApplicationName,
        VersionLabels: [params.VersionLabel]
      },
      function(err, data) {
        if (err) {
          logger('beanstalk.describeApplication request failed. Check your AWS credentials and permissions.');
          callback(err);
        } else {
          if (data.ApplicationVersions && data.ApplicationVersions.length > 0) {
            describeEnvironment(callback);
          } else {
            createApplication(callback);
          }
        }
      }
    );
  };

  var uploadCode = function(callback) {
    logger('Uploading code to S3 bucket "' + params.SourceBundle.S3Bucket + '"...');
    fs.readFile(codePackage, function(err, data) {
      if(err) {
        return callback('Error reading specified package "'+ codePackage + '"');
      }
      S3.upload(
        {
          Bucket: params.SourceBundle.S3Bucket,
          Key: params.VersionLabel + '-' + codePackage,
          Body: data,
          ContentType: 'binary/octet-stream'
        },
        function(err, data) {
          if (err) {
            logger('Upload of "' + codePackage + '" to S3 bucket failed.');
            callback(err);
          } else {
            describeApplication(callback);
          }
        }
      );
    });
  };

  var createBucket = function(callback) {
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
          uploadCode(callback);
        }
      }
    );
  };

  var checkBucket = function(callback) {
    logger('Checking for S3 bucket "' + params.SourceBundle.S3Bucket + '"...');
    S3.headBucket(
      {
        Bucket: params.SourceBundle.S3Bucket
      },
      function(err, data) {
        if (err) {
          if (err.statusCode === 404) {
            createBucket(callback);
          } else {
            logger('S3.headBucket request failed. Check your AWS credentials and permissions.');
            callback(err);
          }
        } else {
          uploadCode(callback);
        }
      }
    );
  };

  checkBucket(callback);
};
