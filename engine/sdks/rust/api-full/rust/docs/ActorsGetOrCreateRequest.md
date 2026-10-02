# ActorsGetOrCreateRequest

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**crash_policy** | [**models::CrashPolicy**](CrashPolicy.md) |  | 
**datacenter** | Option<**String**> |  | [optional]
**input** | Option<**String**> |  | [optional]
**key** | **String** |  | 
**name** | **String** |  | 
**runner_name_selector** | **String** |  | 
**worker** | Option<[**models::WorkerVersionReference**](WorkerVersionReference.md)> | Immutable Worker version to execute. A matching existing actor must be pinned to the same reference. | [optional]

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


