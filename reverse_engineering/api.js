'use strict';

const async = require('async');
const cassandra = require('./cassandraHelper');
const systemKeyspaces = require('./package').systemKeyspaces;
const logHelper = require('./logHelper');

module.exports = {
	connect: function(connectionInfo, logger, cb, app){
		if (!Array.isArray(connectionInfo.hosts)) {
			return cb({ message: 'Hosts were not defined' });
		}

		cassandra.connect(app)(connectionInfo)
			.then(cb, (error) => {
				logger.log('error', error, 'Connection error');
				cb(error);
			});
	},

	disconnect: function(connectionInfo, cb){
		cassandra.close();
		cb();
	},

	testConnection: function(connectionInfo, logger, cb, app){
		logInfo('Test connection', connectionInfo, logger);

		this.connect(connectionInfo, logger, (error) => {
			if (error) {
				logger.log('info', 'Connection failed'+connectionInfo, 'Test connection');
			} else {
				logger.log('info', 'Connection successful', 'Test connection');
			}

			this.disconnect(connectionInfo, () => {});

			return cb(cassandra.prepareError(error));
		}, app);
	},

	getDbCollectionsNames: function(connectionInfo, logger, cb, app) {
		logInfo('Retrieving keyspaces and tables information', connectionInfo, logger);
		const { includeSystemCollection } = connectionInfo;

		cassandra.connect(app)(connectionInfo).then(() => {
				let keyspaces = cassandra.getKeyspacesNames();

				if (!includeSystemCollection) {
					keyspaces = cassandra.filterKeyspaces(keyspaces, systemKeyspaces);
				}

				async.map(keyspaces, (keyspace, next) => {
					cassandra.getTablesNames(keyspace).then(tablesData => {
						const table_name_selector = cassandra.isOldVersion() ? 'columnfamily_name' : 'table_name';
						const tableNames = tablesData.rows.map(table => table[table_name_selector]);
						
						return next(null, cassandra.prepareConnectionDataItem(keyspace, tableNames)); 
					}).catch(next);
				}, (err, result) => {
					return cb(err, result);
				});
			}).catch((error) => {
				logger.log('error', error, 'Retrieving keyspaces and tables information');
				return cb(cassandra.prepareError(error) || 'error');
			});
	},

	getDbCollectionsData: function(data, logger, cb){
		logger.log('info', data, 'Retrieving schema', data.hiddenKeys);
	
		const tables = data.collectionData.collections;
		const keyspacesNames = data.collectionData.dataBaseNames;
		const includeEmptyCollection = data.includeEmptyCollection;
		const recordSamplingSettings = data.recordSamplingSettings;
	
		async.map(keyspacesNames, (keyspaceName, keyspaceCallback) => {
			const tableNames = tables[keyspaceName] || [];
			let udfData = [];
			
			cassandra.getUDF(keyspaceName)
			.then(udf => {
				logger.progress({ message: 'UDF has loaded', containerName: keyspaceName, entityName: '' });

				udfData = cassandra.handleUDF(udf);
				return cassandra.getUDA(keyspaceName)
			})
			.then(uda => {
				logger.progress({ message: 'UDA has loaded', containerName: keyspaceName, entityName: '' });

				let udaData = cassandra.handleUDA(uda);
				pipeline(udaData, udfData);
			})
			.catch(err => {
				pipeline([], []);
			});

			const pipeline = (UDAs, UDFs) => {
				if (!tableNames.length) {
					let packageData = {
						dbName: keyspaceName,
						emptyBucket: true
					};

					packageData.bucketInfo = cassandra.getKeyspaceInfo(keyspaceName);
					packageData.bucketInfo.UDFs = UDFs;
					packageData.bucketInfo.UDAs = UDAs;
					return keyspaceCallback(null, packageData);
				} else {
					async.map(tableNames, (tableName, tableCallback) => {
						let packageData = {
							dbName: keyspaceName,
							collectionName: tableName,
							documents: []
						};
						const loadProgress = progress.bind(null, logger, keyspaceName, tableName);
						const exec = (promise, startMessage, finishMessage) => {
							loadProgress(startMessage);
							return promise.then(result => {
								loadProgress(finishMessage);

								return result;
							});
						};
	
						Promise.all([
							exec(cassandra.getTableMetadata(keyspaceName, tableName), 'Load meta data...', 'Meta data has loaded'),
							exec(cassandra.scanRecords(keyspaceName, tableName, recordSamplingSettings), 'Load records...', 'Records have loaded')
						]).then(([table, records]) => {
							logger.progress({ message: 'Meta data has loaded', containerName: keyspaceName, entityName: tableName });

							packageData = cassandra.getPackageData({
								keyspaceName,
								table,
								tableName,
								UDFs,
								UDAs,
								records
							}, includeEmptyCollection);

							return packageData;
						})
						.then(
							packageData => tableCallback(null, packageData),
							err => tableCallback(err)
						);
					}, (err, res) => {
						if (err) {
							logger.log('error', cassandra.prepareError(err), "Retrieving schema");
						}

						return keyspaceCallback(err, res)
					});
				}
			};
		}, (err, res) => {
			if (!err) {
				logger.progress({ message: 'Reverse-Engineering complete!', containerName: '', entityName: '' });
			}

			return cb(err, res);
		});
	}
};

const logInfo = (step, connectionInfo, logger) => {
	logger.clear();
	logger.log('info', logHelper.getSystemInfo(connectionInfo.appVersion), step);
	logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);
};

const progress = (logger, keyspace, table, message) => {
	logger.progress({
		containerName: keyspace,
		entityName: table,
		message: message
	});
}
