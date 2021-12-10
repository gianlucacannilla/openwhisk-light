const owproxy = require('./owproxy.js'),
      PouchDB = require('pouchdb'),
      db = new PouchDB('owl-stats.db'),
      _ = require("underscore");

PouchDB.plugin(require('pouchdb-find'));

function getAction(req){
    return db.get(req.params.actionName);
}


function getActions(){
  db.allDocs({
    include_docs: true
  }).then(function (result) {
    // handle result
    console.debug("TESI: Return all actions")
    console.debug(result.rows)
  }).catch(function (err) {
    console.log(err);
  });
}

function storeActionCloud(req,responseTime) {
    var doc = {
        "_id": req.params.actionName,
        "avg_response_time_cloud":responseTime,
        "avg_response_time_edge":0,
        "execution_cloud":1,
        "execution_edge":0,
        "execution_failed":0,
      };
    return db.put(doc);
}
function storeActionEdge(req,responseTime) {
    var doc = {
    "_id": req.params.actionName,
    "avg_response_time_cloud":0,
    "avg_response_time_edge":responseTime,
    "execution_cloud":0,
    "execution_edge":1,
    "execution_failed":0,
    };
    return db.put(doc);
}
function updateActionCloud(req,rt){
  return new Promise(function (resolve, reject) {
    db.get(req.params.actionName).then(function (doc) {
      doc.avg_response_time_cloud = ((doc.avg_response_time_cloud * doc.execution_cloud) + rt)/(doc.execution_cloud +1);
      doc.execution_cloud = doc.execution_cloud +1;
      return db.put(doc);
    });
    resolve(action);
    }).catch(function (e) {
      console.error("TESI: Invocazione cloud fallita " + JSON.stringify(e));
      reject(e);
    });
}
function updateActionEdge(req,rt){
  return new Promise(function (resolve, reject) {
    db.get(req.params.actionName).then(function (doc) {
      doc.avg_response_time_edge = ((doc.avg_response_time_edge * doc.execution_edge) + rt)/(doc.execution_edge +1);
      doc.execution_edge = doc.execution_edge +1;
      console.debug(doc.execution_edge);
      return db.put(doc);
    });
    resolve(action);
    }).catch(function (e) {
      console.error("Error" + JSON.stringify(e));
      reject(e);
    });
}

function updateActionFailed(req){
  return new Promise(function (resolve, reject) {
    db.get(req.params.actionName).then(function (doc) {
      doc.execution_failed = doc.execution_failed +1;
      return db.put(doc);
    });
    resolve(action);
    }).catch(function (e) {
      console.error("Error" + JSON.stringify(e));
      reject(e);
    });
}

function storeActionFailed(req) {
  var doc = {
    "_id": req.params.actionName,
    "avg_response_time_cloud":0,
    "avg_response_time_edge":0,
    "execution_cloud":0,
    "execution_edge":0,
    "execution_failed":1,
  };
  return db.put(doc);
}

module.exports = {
    storeActionCloud:storeActionCloud,
    storeActionEdge:storeActionEdge,
    getActions:getActions,
    getAction:getAction,
    updateActionCloud:updateActionCloud,
    updateActionEdge:updateActionEdge,
    storeActionFailed:storeActionFailed,
    updateActionFailed:updateActionFailed,

};

