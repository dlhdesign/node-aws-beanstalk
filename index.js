var fs = require('fs');
var AWS = require('aws-sdk');
var packageConfig = require('./package.json');

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

  var params = {
    ApplicationName: config.appName,
    EnvironmentName: config.appName + '-env',
    Description: config.description,
    VersionLabel: config.version !== undefined ? config.version : packageConfig.version,
    SourceBundle: {
      S3Bucket: config.S3Bucket !== undefined ? config.S3Bucket : config.appName,
      S3Key: codePackage
    },
    AutoCreateApplication: true,
    SolutionStackName: config.solutionStack,
    TemplateName: config.template,
    Tier: {
      Name: config.tier || 'WebServer'
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

  var restartAppServer = function(callback) {
    beanstalk.restartAppServer(
      pick(params,['EnvironmentName']),
      function(err, data) {
      if (err) {
        logger('Environment restart failed.');
        callback(err);
      } else {
        callback();
      }
    });
  };

  var createEnvironment = function(callback) {
    beanstalk.createEnvironment(
      pick(params,['ApplicationName', 'EnvironmentName', 'Description', 'OptionSettings', 'SolutionStackName', 'TemplateName', 'VersionLabel', 'Tier', 'Tags']),
      function(err, data) {
      if (err) {
        logger('Create environment failed. Check your iam:PassRole permissions.');
        callback(err);
      } else {
        restartAppServer(callback);
      }
    });
  };

  var updateEnvironment = function(callback) {
    beanstalk.updateEnvironment(
      pick(params,['EnvironmentName', 'Description', 'OptionSettings', 'SolutionStackName', 'TemplateName', 'VersionLabel', 'Tier']),
      function(err, data) {
      if (err) {
        logger('Create environment failed. Check your iam:PassRole permissions.');
        callback(err);
      } else {
        restartAppServer(callback);
      }
    });
  };

  var describeEnvironment = function(callback) {
    beanstalk.describeEnvironments(
      {
        ApplicationName: params.ApplicationName,
        EnvironmentNames: [params.EnvironmentName]
      },
      function(err, data) {
        if (err) {
          if (err.statusCode === 404) {
            createEnvironment(callback);
          } else {
            logger('beanstalk.describeApplication request failed. Check your AWS credentials and permissions.');
            callback(err);
          }
        } else {
          updateEnvironment(callback);
        }
      }
    );
  };

  var createApplication = function(callback) {
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
    beanstalk.describeApplicationVersions(
      {
        ApplicationName: params.ApplicationName,
        VersionLabels: [params.VersionLabel]
      },
      function(err, data) {
        if (err) {
          if (err.statusCode === 404) {
            createApplication(callback);
          } else {
            logger('beanstalk.describeApplication request failed. Check your AWS credentials and permissions.');
            callback(err);
          }
        } else {
          updateEnvironment(callback);
        }
      }
    );
  };

  var createBucket = function(callback) {
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

  var uploadCode = function(callback) {
    fs.readFile(codePackage, function(err, data) {
      if(err) {
        return callback('Error reading specified package "'+ codePackage + '"');
      }
      S3.upload(
        {
          Bucket: params.SourceBundle.S3Bucket,
          Key: codePackage,
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
