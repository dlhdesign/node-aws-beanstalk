# node-aws-beanstalk

A module that helps you automate AWS beanstalk application deployment.
All application and environment configuration is managed in the codebase. So you can version control everything and automate the deployment instead of click click click in AWS console.

Inspired by [https://github.com/ThoughtWorksStudios/node-aws-lambda](https://github.com/ThoughtWorksStudios/node-aws-lambda)

# Gulp example:

gulpfile.js
```node
var gulp = require('gulp');
var zip = require('gulp-zip');
var del = require('del');
var install = require('gulp-install');
var runSequence = require('run-sequence');
var awsBeanstalk = require("node-aws-beanstalk");

gulp.task('clean', function() {
  return del(['./dist', './dist.zip']);
});

gulp.task('js', function() {
  return gulp.src('index.js')
    .pipe(gulp.dest('dist/'));
});

gulp.task('node-mods', function() {
  return gulp.src('./package.json')
    .pipe(gulp.dest('dist/'))
    .pipe(install({production: true}));
});

gulp.task('zip', function() {
  return gulp.src(['dist/**/*', '!dist/package.json'])
    .pipe(zip('dist.zip'))
    .pipe(gulp.dest('./'));
});

gulp.task('upload', function(callback) {
  awsBeanstalk.deploy('./dist.zip', require("./beanstalk-config.js"), callback);
});

// update task can be used to update the configured environment
gulp.task('update', function(callback) {
  awsBeanstalk.update(require("./beanstalk-config.js"), callback);
});

gulp.task('deploy', function(callback) {
  return runSequence(
    ['clean'],
    ['js', 'node-mods'],
    ['zip'],
    ['upload'],
    callback
  );
});
```
beanstalk-config.js
```node
module.exports = {
  accessKeyId: <access key id>,  // optional
  secretAccessKey: <secret access key>,  // optional
  profile: <shared credentials profile name>, // optional for loading AWS credientail from custom profile
  region: '<region>',
  appName: 'MyApp',
  environmentName: 'MyApp-integration', // optional, default is appName + '-env'

  // either the 'solutionStack' OR 'template' key MUST be provided, but not both
  solutionStack: '64bit Amazon Linux 2015.03 v2.0.6 running Node.js',
  template: 'myEnvironmentTemplate',

  version: '0.1.0', // optional, else will pull version from package.json
  S3Bucket: 'mys3bucket', // DEPRECATED - use bucketConfig.Bucket
  tier: 'Worker', // optional, else will use 'WebServer'
  environmentSettings: [
    {
      Namespace: 'aws:autoscaling:launchconfiguration',
      OptionName: 'IamInstanceProfile',
      Value: 'ElasticBeanstalkProfile'
    },
    // ...
  ],
  environmentTags: [ // optional
    {
      key: 'foo',
      value: 'bar'
    },
    // ...
  ],
  bucketConfig: { // optional - passed into S3.createBucket()
    Bucket: 'mys3bucket', // optional, else will attempt to use appName
    // ...
  },
  bucketTags: [ // optional
    {
      key: 'foo',
      value: 'bar'
    },
    // ...
  ]
}
```
Additional environment settings can be found [here](http://docs.aws.amazon.com/elasticbeanstalk/latest/dg/command-options.html#command-options-general).

# Proxy setup
Deployment via https proxy is supported by setting environment variable "HTTPS_PROXY". For example:

```terminal
> HTTPS_PROXY="https://myproxy:8080" gulp deploy
```

# License

(The MIT License)

Copyright (c) 2015 David Hutchings

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
