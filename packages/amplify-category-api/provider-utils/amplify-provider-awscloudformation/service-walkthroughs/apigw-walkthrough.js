const inquirer = require('inquirer');

async function serviceWalkthrough(context, defaultValuesFilename) {
  const { amplify } = context;
  const defaultValuesSrc = `${__dirname}/../default-values/${defaultValuesFilename}`;
  const { getAllDefaults } = require(defaultValuesSrc);
  const allDefaultValues = getAllDefaults(amplify.getProjectDetails());

  let answers = {};
  let dependsOn = {};

  const apiNames = await askApiNames(context, allDefaultValues);
  answers = { ...answers, ...apiNames };

  const pathsAnswer = await askPaths(context);
  answers = { ...answers, paths: pathsAnswer.paths, functionArns: pathsAnswer.functionArns };
  ({ dependsOn } = pathsAnswer);

  const privacy = await askPrivacy(context);
  answers = { ...answers, privacy, dependsOn };

  if (context.amplify.getProjectDetails() && context.amplify.getProjectDetails().amplifyMeta &&
    context.amplify.getProjectDetails().amplifyMeta.providers &&
    context.amplify.getProjectDetails().amplifyMeta.providers['amplify-provider-awscloudformation']
  ) {
    // TODO: read from utility functions (Dustin PR)
    const { amplifyMeta } = context.amplify.getProjectDetails();
    const providerInfo = amplifyMeta.providers['amplify-provider-awscloudformation'];

    answers.privacy.authRoleName = providerInfo.AuthRoleName;
    answers.privacy.unAuthRoleName = providerInfo.UnauthRoleName;
  }

  return { answers, dependsOn };
}

async function askApiNames(context, defaults) {
  const { amplify } = context;
  // TODO: Check if default name is already taken
  const answer = await inquirer.prompt([
    {
      name: 'resourceName',
      type: 'input',
      message: 'Please provide a friendly name for your resource that will be used to label this category in the project:',
      default: defaults.resourceName,
      validate: amplify.inputValidation({
        validation: {
          operator: 'regex',
          value: '^[a-zA-Z0-9]+$',
          onErrorMsg: 'Resource name should be alphanumeric',
        },
        required: true,
      }),
    },
    {
      name: 'apiName',
      type: 'input',
      message: 'Please provide an API name',
      default: defaults.apiName,
      validate(value) {
        const pass = value.length > 0;

        // TODO: check names with existing apis
        // let yamlDef = cloudLogicDefinition.projectDefinition.yamlDefinition;

        // // Check if API already exists
        // if (yamlDef.features.cloudlogic && yamlDef.features.cloudlogic.components &&
        //   yamlDef.features.cloudlogic.components[value]) {
        //   return 'API ' + value + ' already exists';
        // }
        if (pass) {
          return true;
        }
        return 'Please enter a valid API name';
      },
    },
  ]);

  return answer;
}

async function askPrivacy() {
  const answer = await inquirer.prompt({
    name: 'privacy',
    type: 'list',
    message: 'Which kind of privacy your API should have?',
    choices: [
      {
        name: 'Open (No security)',
        value: 'open',
      },
      {
        name: 'Protected (AWS_IAM restricted to guest and sign-in users)',
        value: 'protected',
      },
      {
        name: 'Private (AWS_IAM restricted to sign-in users only)',
        value: 'private',
      },
    ],
  });

  const privacy = {};
  privacy[answer.privacy] = true;
  const roles = { unAuthRoleName: 'unauth-role-name', authRoleName: 'auth-role-name' };// await context.amplify.executeProviderUtils(context, 'amplify-provider-awscloudformation', 'staticRoles');
  privacy.unAuthRoleName = roles.unAuthRoleName;
  privacy.authRoleName = roles.authRoleName;

  return privacy;
}

async function askPaths(context) {
  /* TODO: add spinner when
  checking if the account had
  functions deployed and hide the option from the menu */
  const existingLambdaArns = true;
  const existingFunctions = functionsExist(context);

  const choices = [
    {
      name: 'Create a new Lambda function',
      value: 'newFunction',
    },
  ];

  if (existingLambdaArns) {
    choices.push({
      name: 'Use a Lambda function already deployed on AWS',
      value: 'arn',
    });
  }

  if (existingFunctions) {
    choices.push({
      name: 'Use a Lambda function already added in the current Amplify project',
      value: 'projectFunction',
    });
  }
  const questions = [
    {
      name: 'name',
      type: 'input',
      message: 'Please provide a path, e.g. /items',
      default: '/items',
    },
    {
      name: 'functionType',
      type: 'list',
      message: 'Please select lambda source',
      choices,
    },
  ];

  let addAnotherPath;
  const paths = [];
  const dependsOn = [];
  const functionArns = [];

  do {
    const answer = await inquirer.prompt(questions);
    let path = { name: answer.name };
    let lambda;
    do {
      lambda = await askLambdaSource(context, answer.functionType, answer.name);
    } while (!lambda);
    path = { ...path, ...lambda };
    paths.push(path);

    if (lambda.lambdaFunction && !lambda.lambdaArn) {
      dependsOn.push({
        category: 'function',
        resourceName: lambda.lambdaFunction,
        attributes: ['Name', 'Arn'],
      });
    }

    functionArns.push(lambda);


    addAnotherPath = (await inquirer.prompt({
      name: 'anotherPath',
      type: 'confirm',
      message: 'Do you want to add another path?',
      default: false,
    })).anotherPath;
  } while (addAnotherPath);

  return { paths, dependsOn, functionArns };
}

function functionsExist(context) {
  if (!context.amplify.getProjectDetails().amplifyMeta.function) {
    return false;
  }

  const functionResources = context.amplify.getProjectDetails().amplifyMeta.function;
  const lambdaFunctions = [];
  Object.keys(functionResources).forEach((resourceName) => {
    if (functionResources[resourceName].service === 'Lambda') {
      lambdaFunctions.push(resourceName);
    }
  });

  if (lambdaFunctions.length === 0) {
    return false;
  }

  return true;
}

async function askLambdaSource(context, functionType, path) {
  switch (functionType) {
    case 'arn': return askLambdaArn(context);
    case 'projectFunction': return askLambdaFromProject(context);
    case 'newFunction': return newLambdaFunction(context, path);
    default: throw new Error('Type not supported');
  }
}

function newLambdaFunction(context, path) {
  let add;
  try {
    ({ add } = require('amplify-category-function'));
  } catch (e) {
    throw new Error('Function plugin not installed in the CLI. Please install it to use this feature');
  }
  context.api = {
    path,
    functionTemplate: 'serverless',
  };
  return add(context, 'amplify-provider-awscloudformation', 'Lambda')
    .then((resourceName) => {
      context.print.success('Succesfully added Lambda function locally');
      return { lambdaFunction: resourceName };
    });
}

async function askLambdaFromProject(context) {
  const functionResources = context.amplify.getProjectDetails().amplifyMeta.function;
  const lambdaFunctions = [];
  Object.keys(functionResources).forEach((resourceName) => {
    if (functionResources[resourceName].service === 'Lambda') {
      lambdaFunctions.push(resourceName);
    }
  });

  const answer = await inquirer.prompt({
    name: 'lambdaFunction',
    type: 'list',
    message: 'Please select lambda function to invoke by this path',
    choices: lambdaFunctions,
  });

  return { lambdaFunction: answer.lambdaFunction };
}

async function askLambdaArn(context) {
  const regions = await context.amplify.executeProviderUtils(context, 'amplify-provider-awscloudformation', 'getRegions');

  const regionQuestion = {
    type: 'list',
    name: 'region',
    message: 'Select lambda function region',
    choices: regions,
  };

  const regionAnswer = await inquirer.prompt([regionQuestion]);

  const lambdaFunctions = await context.amplify.executeProviderUtils(context, 'amplify-provider-awscloudformation', 'getLambdaFunctions', { region: regionAnswer.region });

  const lambdaOptions = lambdaFunctions.map(lambdaFunction => ({
    value: {
      resourceName: lambdaFunction.FunctionName.replace(/[^0-9a-zA-Z]/gi, ''),
      Arn: lambdaFunction.FunctionArn,
      FunctionName: lambdaFunction.FunctionName,
    },
    name: `${lambdaFunction.FunctionName} (${lambdaFunction.FunctionArn})`,
  }));

  if (lambdaOptions.length === 0) {
    context.print.error('You do not have any lambda functions configured for the selected region');
    return null;
  }

  const lambdaCloudOptionQuestion = {
    type: 'list',
    name: 'lambdaChoice',
    message: 'Please select a Lambda function',
    choices: lambdaOptions,
  };

  const lambdaCloudOptionAnswer = await inquirer.prompt([lambdaCloudOptionQuestion]);

  return { lambdaArn: lambdaCloudOptionAnswer.lambdaChoice.Arn, lambdaFunction: lambdaCloudOptionAnswer.lambdaChoice.FunctionName.replace(/[^0-9a-zA-Z]/gi, '') };
}

module.exports = { serviceWalkthrough };