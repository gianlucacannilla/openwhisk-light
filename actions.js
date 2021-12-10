const DockerBackend = require('./dockerbackend'),
      DockerBackendWithPreemption = require('./dockerBackendWithPreemption'),
      messages = require('./messages'),
      config = require("./config"),
      url = require('url'),
      activations = require('./activations'),
      schedulingStorage = require('./schedulingStorage'),
      uuid = require("uuid"),
      retry = require('retry-as-promised'),
      actionproxy = require('./actionproxy'),
      STATE = require('./utils').STATE,
      owproxy = require('./owproxy'),
      
      dockerhost = config.docker_host,
      backend = (config.preemption && config.preemption.enabled == 'true') ?
                new DockerBackendWithPreemption({dockerurl: dockerhost}) :
                new DockerBackend({dockerurl: dockerhost}),
      retryOptions = {
        max: config.retries.number, 
        timeout: 60000, // TODO: use action time limit?
        match: [ 
          messages.TOTAL_CAPACITY_LIMIT
        ],
        backoffBase: config.retries.timeout,
        backoffExponent: 1, 
        report: function(msg){ console.log(msg, ""); }, 
        name:  'Action invoke' 
      },

      //e.g. { $ACTION_NAME: "exec": { "kind": "nodejs", "code": "function main(params) {}" .... },}
      actions = {};
let network_latency;
_getServerResponseTime();
const {param} = require("express/lib/router");
const { parse } = require('tough-cookie');
const constants = require('./constants');
console.debug("dockerhost: " + dockerhost);





 /**
 * Invokes action in Openwhisk light platform
 *
 * Code flow:
 *
 * Get action from local repository
 *   if not exist, get from ownext and update local repository
 *
 *  Retry Allocate container
 *    if failed:
 *      ownext.invoke
 *
 *  activations.create
 *    if not blocking respond with result
 *
 *  actionProxy.invoke
 *   update activation
 *
 *  if blocking
 *    respond with result
 *
 * @param {Object} req
 * @param {Object} res
 */
function handleInvokeAction(req, res) {

  var start = new Date().getTime();
  var api_key = _from_auth_header(req);

  function respond(result, err){
    var rc = err ? 502 : 200;
    var obj = {
      "response": {
        "result":result,
        "status":"success",
        "succes":true
      },
    };
    res.status(rc).send(obj);
  }
  

  function updateAndRespond(actionContainer, activation, result, err) {
    var rc = err ? 502 : 200;
	  var response = _buildResponse(result, err);

	  activations.getActivation(activation.activationId).then(function(activationDoc) {
      console.debug('updating activation: ' + JSON.stringify(activationDoc));
      var end = new Date().getTime();
	    activationDoc.activation.end = end;
      activationDoc.activation.duration = (end - activationDoc.activation.start);
      activationDoc.activation.response = response;
      activationDoc.activation.logs = actionContainer.logs || [];

	    //store activation 
	    activations.updateActivation(activationDoc).then(function (doc) {
	    console.debug("returned response: " + JSON.stringify(doc));
        if (req.query.blocking === "true") {
          console.debug("responding: " + JSON.stringify(response));

          if(req.query.result === "true") {
          
		    res.status(rc).send(response.result);
		  } else {
		    res.status(rc).send(activationDoc.activation);
		  }
        }
	  }).catch(function (err) {
        _processErr(req, res, err);
      });
    }).catch(function (err) {
      _processErr(req, res, err);
    });
  }
  //schedulingStorage.getAll();
  //schedulingStorage.getActions();
  console.debug("TESI: Parameters" + JSON.stringify(req.body.execution));
  var execution_params;
  if(req.body.execution)
    execution_params=req.body.execution;
  else execution_params = {
      cpu: constants.CPU,
      ram: constants.RAM,
      response_time:constants.RESPONSE_TIME
    };
  const startTime = new Date();
  var parsedData = JSON.parse(execution_params);
  var _mode = parsedData.debug;
  console.debug("TESI: Mode -> "+_mode);
   console.debug("TESI: Use cases -> "+parsedData.resources);
  if(_mode == 0){
    var _filteringResponse = _filtering(parsedData)
    //var _filteringResponse = _filtering(execution_params);
    console.debug("TESI: _filteringResponse-> "+_filtering(parsedData));
    console.debug("TESI: _scoring-> "+_scoring(parsedData));
    delete req.body["execution"];
    if(_filteringResponse==constants.EDGE_CLOUD){
      console.debug("TESI: Can Edge"+_filteringResponse);
      var _scoringResponse=_scoring(parsedData);
      console.debug("TESI: Scoring response _scoringResponse"+ _scoringResponse);
      if(_scoringResponse==constants.EDGE && ( parsedData.resources == 0 || parsedData.resources == 2 )){
        console.debug("TESI: Go Edge"+_filteringResponse);
        _getAction(req).then((action) => {
          retry(function () { return backend.getActionContainer(req.params.actionName, action.exec.kind, action.exec.image) }, retryOptions).then((actionContainer) => {
            _createActivationAndRespond(req, res, start).then((activation) => {
                console.debug("container allocated");
                actionproxy.init(action, actionContainer).then(() => {
                  console.debug("container initialized");
                  var params = req.body;
                  action.parameters.forEach(function(param) { params[param.key]=param.value; });
                  actionproxy.run(actionContainer, api_key, params).then(function(result){
                    console.debug("invoke request returned with " + JSON.stringify(result));
                    backend.invalidateContainer(actionContainer);
                    updateAndRespond(actionContainer, activation, result);
                    var rt = new Date()-startTime;
                    schedulingStorage.getAction(req).then(function (doc) {
                      console.debug("TESI:Action Edge find");
                      console.debug(doc)
                      //Update Action
                      schedulingStorage.updateActionEdge(req,rt).then(function (doc) {
                        console.debug("TESI:Action  Edge update");
                        console.debug(doc)
                        }).catch(function (err) {
                          console.debug("TESI: Error update action"+err);
                        });
                      }).catch(function (err) {
                        console.debug("TESI: Not find action"+err);
                        //Action not find store
                        schedulingStorage.storeActionEdge(req,rt).then(function (doc) {
                          console.debug("TESI:Action saved");
                          console.debug(doc);
                          }).catch(function (err) {
                            console.debug("TESI: Error saved action"+err);
                        });
                    });
                    return;
                  }).catch(function(err){
                    console.error("invoke request failed with " + err);
                    backend.invalidateContainer(actionContainer);
                    updateAndRespond(actionContainer, activation, {}, err);
                  });					
              }).catch(function(err){
                  console.error("container init failed with " + err);
                  backend.invalidateContainer(actionContainer);
                  updateAndRespond(actionContainer, activation, {}, err);
              });
            }).catch(function (err) {
              _processErr(req, res, err);
            });
          }).catch(function (e) {
              console.error("retry failed to get action container from backend: " + e);
              if (e != messages.TOTAL_CAPACITY_LIMIT) {
                _processErr(req, res, e);
              } else {
                  _executionCloud(req).then((action) => {
                    var rt=  new Date()- startTime;
                    //Find Action
                    schedulingStorage.getAction(req).then(function (doc) {
                      console.debug("TESI:Action find");
                      console.debug(doc)
                      //Update Action
                      schedulingStorage.updateActionCloud(req,rt).then(function (doc) {
                        console.debug("TESI:Action update");
                        console.debug(doc)
                        }).catch(function (err) {
                          console.debug("TESI: Error update action"+err);
                        });
                      }).catch(function (err) {
                        console.debug("TESI: Not find action"+err);
                        //Action not find store
                        schedulingStorage.storeActionCloud(req,rt).then(function (doc) {
                          console.debug("TESI:Action saved");
                          console.debug(doc);
                          }).catch(function (err) {
                            console.debug("TESI: Error saved action"+err);
                        });
                    });
                    console.debug("POSSO RISPONDERE");
                    respond(action);
                  }).catch(function (err) {
                      respond({}, e);
                      _processErr(req, res, err);
                  });
                }
          });
        }).catch(function (err) {
          _processErr(req, res, err);
        });
      }
      else if(parsedData.resources == 2 || parsedData.resources == 1 ){
        _executionCloud(req).then((action) => {
          var rt=new Date()-startTime;
          //Find Action
          schedulingStorage.getAction(req).then(function (doc) {
            console.debug("TESI:Action find cloud");
            console.debug(doc)
            //Update Action
            schedulingStorage.updateActionCloud(req,rt).then(function (doc) {
              console.debug("TESI:Action update cloud");
              console.debug(doc)
              }).catch(function (err) {
                console.debug("TESI: Error update action cloud"+err);
              });
            }).catch(function (err) {
              console.debug("TESI: Not find action cloud"+err);
              //Action not find store
              schedulingStorage.storeActionCloud(req,rt).then(function (doc) {
                console.debug("TESI:Action saved cloud");
                console.debug(doc);
                }).catch(function (err) {
                  console.debug("TESI: Error saved action cloud "+err);
              });
          });
          console.debug("POSSO RISPONDERE");
          respond(action);
        }).catch(function (err) {
            respond({}, e);
            _processErr(req, res, err);
        });
      }
    }else if(_filteringResponse==constants.EDGE && (parsedData.resources == 2 || parsedData.resource==0)){
      _getAction(req).then((action) => {
        retry(function () { return backend.getActionContainer(req.params.actionName, action.exec.kind, action.exec.image) }, retryOptions).then((actionContainer) => {
          _createActivationAndRespond(req, res, start).then((activation) => {
              console.debug("container allocated");
              actionproxy.init(action, actionContainer).then(() => {
                console.debug("container initialized");
                var params = req.body;
                action.parameters.forEach(function(param) { params[param.key]=param.value; });
                actionproxy.run(actionContainer, api_key, params).then(function(result){
                  console.debug("invoke request returned with " + JSON.stringify(result));
                  backend.invalidateContainer(actionContainer);
                  updateAndRespond(actionContainer, activation, result);
                  var rt = new Date()-startTime;
                  schedulingStorage.getAction(req).then(function (doc) {
                    console.debug("TESI:Action Edge find");
                    console.debug(doc)
                    //Update Action
                    schedulingStorage.updateActionEdge(req,rt).then(function (doc) {
                      console.debug("TESI:Action  Edge update");
                      console.debug(doc)
                      }).catch(function (err) {
                        console.debug("TESI: Error update action"+err);
                      });
                    }).catch(function (err) {
                      console.debug("TESI: Not find action"+err);
                      //Action not find store
                      schedulingStorage.storeActionEdge(req,rt).then(function (doc) {
                        console.debug("TESI:Action saved");
                        console.debug(doc);
                        }).catch(function (err) {
                          console.debug("TESI: Error saved action"+err);
                      });
                  });
                  return;
                }).catch(function(err){
                  console.error("invoke request failed with " + err);
                  backend.invalidateContainer(actionContainer);
                  updateAndRespond(actionContainer, activation, {}, err);
                });					
            }).catch(function(err){
                console.error("container init failed with " + err);
                backend.invalidateContainer(actionContainer);
                updateAndRespond(actionContainer, activation, {}, err);
            });
          }).catch(function (err) {
            _processErr(req, res, err);
          });
        }).catch(function (e) {
            console.error("retry failed to get action container from backend: " + e);
            if (e != messages.TOTAL_CAPACITY_LIMIT) {
              _processErr(req, res, e);
            } else {
                _executionCloud(req).then((action) => {
                  var rt=  new Date()- startTime;
                  //Find Action
                  schedulingStorage.getAction(req).then(function (doc) {
                    console.debug("TESI:Action find");
                    console.debug(doc)
                    //Update Action
                    schedulingStorage.updateActionCloud(req,rt).then(function (doc) {
                      console.debug("TESI:Action update");
                      console.debug(doc)
                      }).catch(function (err) {
                        console.debug("TESI: Error update action"+err);
                      });
                    }).catch(function (err) {
                      console.debug("TESI: Not find action"+err);
                      //Action not find store
                      schedulingStorage.storeActionCloud(req,rt).then(function (doc) {
                        console.debug("TESI:Action saved");
                        console.debug(doc);
                        }).catch(function (err) {
                          console.debug("TESI: Error saved action"+err);
                      });
                  });
                  console.debug("POSSO RISPONDERE");
                  respond(action);
                }).catch(function (err) {
                    respond({}, e);
                    _processErr(req, res, err);
                });
              }
        });
      }).catch(function (err) {
        _processErr(req, res, err);
      });
    }
    else if(_filteringResponse==constants.CLOUD && (parsedData.resources == 2 || parsedData.resource == 1)){
      console.debug("TESI: Go Cloud"+_filteringResponse)
        _executionCloud(req).then((action) => {
          var rt=new Date()-startTime;
          //Find Action
          schedulingStorage.getAction(req).then(function (doc) {
            console.debug("TESI:Action find cloud");
            console.debug(doc)
            //Update Action
            schedulingStorage.updateActionCloud(req,rt).then(function (doc) {
              console.debug("TESI:Action update cloud");
              console.debug(doc)
              }).catch(function (err) {
                console.debug("TESI: Error update action cloud"+err);
              });
            }).catch(function (err) {
            console.debug("TESI: Not find action cloud"+err);
              //Action not find store
              schedulingStorage.storeActionCloud(req,rt).then(function (doc) {
                console.debug("TESI:Action saved cloud");
              console.debug(doc);
              }).catch(function (err) {
              console.debug("TESI: Error saved action cloud"+err);
              });
            });
          console.debug("VADO: Posso andare"+JSON.stringify(action));
          respond(action);
          return;
        }).catch(function (err) {
            console.debug("VADO: Error" +JSON.stringify(err));
            respond({}, e);
            _processErr(req, res, err);
        });
    }
    else {
        console.debug("TESI: Can't action "+_filteringResponse)
        schedulingStorage.getAction(req,0).then(function (doc) {
          console.debug("TESI: Can't action -> Action find failed");
          console.debug(doc)
          //Update Action
          schedulingStorage.updateActionFailed(req).then(function (doc) {
            console.debug("TESI: Can't action -> Update action failed ");
            console.debug(doc)
          }).catch(function (err) {
            console.debug("TESI: Can't action -> Error update action"+err);
            });
        }).catch(function (err) {
          console.debug("TESI: Can't action -> Not find action "+err);
            //Action not find store
          schedulingStorage.storeActionFailed(req).then(function (doc) {
            console.debug("TESI:Can't action -> Action saved cloud");
            console.debug(doc);
            }).catch(function (err) {
            console.debug("TESI: Can't action -> Error saved action "+err);
          });
        });
      respond({},"");
    }
    schedulingStorage.getActions();
  }
  else 
    schedulingStorage.getActions();
}

/**
 * Action get name. Also currently used to update openwhisk local actions registry
 * 
 * Get action from openwhisk global
 * Update local actions registry
 * Update bursting service actions registry
 * @param {Object} req
 * @param {Object} res
 */
function handleGetAction(req, res) {
  var start = new Date().getTime();
  _getAction(req, true).then((action) => {
    res.send(action);
  }).catch((err)=>{
    console.error("action get error: " + err);
    _processErr(req, res, err);
  });
}

/**
 * Delegate action delete to openwhisk next
 * 
 * delete action from local registry
 * delete action from bursting service
 * @param {Object} req
 * @param {Object} res
 */
function handleDeleteAction(req, res) {
  var api_key = _from_auth_header(req);
  var start = new Date().getTime();

  owproxy.deleteAction(req).then(function (result) {
	delete actions[req.params.actionName];
	res.send(result);
  }).catch(function (e) {
	console.error(JSON.stringify(e));
	_processErr(req, res, e);
  });
}

/**
 * - delegate action update to openwhisk next
 * - update action in local registry
 * @param {Object} req
 * @param {Object} res
 */
function handleUpdateAction(req, res) {
  owproxy.updateAction(req).then(function (result) {
    console.debug("action update result: " + JSON.stringify(result));
    _updateAction(req, result).then(()=>{
      console.debug("action updated");
      res.send(result); 
    });
  }).catch(function (e) {
    console.error(JSON.stringify(e));
    _processErr(req, res, e);
  });
}

function _from_auth_header(req) {
  var auth = req.get("authorization");
  auth = auth.replace(/basic /i, "");
  auth = new Buffer(auth, 'base64').toString('ascii');
  return auth;
}

function _auth_match(action, auth){
  return action.api_key == auth.replace(/basic /i, "");
}

function _updateAction(req, action){
  var that = this;
  return new Promise(function (resolve, reject) {
    backend.fetch(req.params.actionName, action.exec.kind, action.exec.image).then((result) => {
      console.debug("action " + req.params.actionName + " registered");
      action.api_key = req.get("authorization").replace(/basic /i, "");
      actions[req.params.actionName] = action;

      console.debug("Registered actions ==> " + JSON.stringify(actions));
      resolve();
    }).catch(function (e) {
      console.error("Error fetching an action: " + e);
      reject(e);
    });
  });
}

/* Static Computation logic*/
/*TODO Rename Filtering*/
function _filtering(executionParams){
  if(!"cpu" in  executionParams)
    executionParams.cpu=constants.CPU
  if(!"ram" in  executionParams)
    executionParams.ram=constants.RAM
  if(!"response_time" in  executionParams)
    executionParams.response_time=constants.RESPONSE_TIME
  const edge_cpu=1
  const edge_ram=2000;
  console.debug("TESI: Execution Params" + JSON.stringify(executionParams))
  if(parseInt(executionParams.cpu)<=edge_cpu && parseFloat(executionParams.ram)<=edge_ram){
    if(parseFloat(executionParams.response_time)<parseFloat(network_latency))
      return constants.EDGE;
    else
      return constants.EDGE_CLOUD;
  }
  else{
    if(parseFloat(executionParams.response_time)<parseFloat(network_latency))
      return constants.CLOUD;
    return constants.CAN_NOT;
  }
}
/*Dynamic Compuation Logic*/
/*Rename Scoring*/
function _scoring(executionParams){
  //Create formula
  var cpu_value = executionParams.cpu;
  var ram_value = executionParams.ram;
  var rt_value = executionParams.response_time;
  var cpu_score = 0;
  var ram_score = 0 ;
  var rt_score = 0;
  if(cpu_value > 2)
    cpu_score = 1;
  if(ram_value>2000)
    ram_score = 1;
  if(rt_value <= 200 )
    rt_score = -2;
  if(rt_value >200 && rt_value <= 500)
    rt_score = -1;
  var scoring = cpu_score + ram_score + rt_score;
  if(scoring >=0)
    return constants.CLOUD;
  return constants.EDGE;

}
//ExecutionOnCloud
function _executionCloud(req){
  return new Promise(function (resolve,reject) {owproxy.getActionInvoke(req).then((action) => {
      console.debug("TESI: Invocazione cloud riuscita " + JSON.stringify(action));
      resolve(action);
    }).catch(function (e) {
      console.error("TESI: Invocazione cloud fallita " + JSON.stringify(e));
      reject(e)
    });
  });
}


function _getServerResponseTime(){
  var http = require('http');
  var start = new Date();
  http.get({host: '10.31.127.240', port: 31001}, function(res) {
    network_latency = new Date() - start;
    console.debug('Request took:', new Date() - start, 'ms');
});
}
/**
 * Get action from local cashe.
 *
 * In case action missing in local cashe request action from openwhisk next and update local cashe
 * 
 * delete action from local registry
 * delete action from bursting service
 * @param {Object} req
 * @param {Boolean} fetch - if specified will explicitly update local cache with action from remote
 */
function _getAction(req, fetch) {
  var that = this;
  return new Promise(function (resolve, reject) {
	var action = actions[req.params.actionName];
	if (!fetch && action && _auth_match(action, req.get("authorization"))){
      resolve(action);
	} else {
	  //no cached action, throwing ACTION MISSING error so the caller will know it needs to be created
	  console.debug("getting action " + req.params.actionName + " from owproxy");
	  owproxy.getAction(req).then((action) => {
        if(actions[req.params.actionName] && action.version == actions[req.params.actionName].version){
          console.debug("resolved action version identical to cached one: " + action.version + ", no need to update local cache");
          return resolve(action);
        }

        _updateAction(req, action).then(() => {

          console.debug("Registered actions ==> " + JSON.stringify(actions));
          resolve(action);
        }).catch(function (e) {
          console.error("Error registering action: " + e);
          reject(e);
        });
      }).catch(function (e) {
        console.log("Error getting action: " + e);
		reject(e);
	  });
	}
  });
}

function _createActivationAndRespond(req, res, start){
  var activationId = uuid.v4();
  var activation = {
	activationId,
    "logs": [],
    name: req.params.actionName,
    namespace: req.params.namespace,
    "publish": false,
    start,
    "subject": "owl@il.ibm.com",
    "version": "0.0.0"
  }
	
  return new Promise(function(resolve,reject) {
    activations.createActivation(activation).then(function (response) {
	  console.debug("create activation response: " + JSON.stringify(response));
		
	  // if not blocking respond with activation id and continue with the flow
      if(req.query.blocking !== "true"){
	    console.debug("returning activation: " + JSON.stringify(activation));
        res.send(activation);
      }		   
	  resolve(activation);
    }).catch(function (err) {
      console.log(err);
      reject(err);
	});
  });
}

function _buildResponse(result, err){
  var response;

  if (err !== undefined) {
    var msg = _getErrorMessage(err);
    console.debug("error message: " + JSON.stringify(msg));
    response = {
      "result": {
        error: msg
      },
      "status": "action developer error",
      "success": false
    };
  } else {
    response = {
      result,
      "status": "success",
      "success": true
    };
  }
  return response;
}

function _processErr(req, res, err){
  if(err.name && err.statusCode){
    res.send(err);
  }else{
    var msg = _getErrorMessage(err);
    console.debug("error occured: " + msg);
         
    res.status(404).send({
      error: msg,
      code: -1
    });
  }
}

function _getErrorMessage(error){
    return error ? (error.error ? (error.error.error ? error.error.error : error.error) : error) : "";
}

module.exports = {
  handleInvokeAction:handleInvokeAction, 
  handleDeleteAction:handleDeleteAction, 
  handleGetAction:handleGetAction,
  handleUpdateAction
};

