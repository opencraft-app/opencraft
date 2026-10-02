# ActorsCreateRequest

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**crash_policy** | [**models::CrashPolicy**](CrashPolicy.md) |  | 
**datacenter** | Option<**String**> |  | [optional]
**input** | Option<**String**> | Arbitrary base64 encoded binary data. | [optional]
**key** | Option<**String**> |  | [optional]
**name** | **String** |  | 
**runner_name_selector** | **String** |  | 
**worker** | Option<[**models::WorkerVersionReference**](WorkerVersionReference.md)> | Immutable Worker version to execute. Omit only for runner-provided compatibility Workers. | [optional]

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


