// Package util ...
package util

// 关于Region的数字Id
// Lighthouse：http://tapd.oa.com/CVMOPS/markdown_wikis/show/#1210128631000407277
// 计费侧：http://tapd.oa.com/pt_jifei/markdown_wikis/show/#1210140771000550231
// 前端：http://qcc.oa.com/manager/region

var regionList = []*struct {
	Name      string
	Id        int
	ShortName string
}{
	{
		Name:      "ap-guangzhou",
		Id:        1,
		ShortName: "gz",
	},
	{
		Name:      "ap-shanghai",
		Id:        4,
		ShortName: "sh",
	},
	{
		Name:      "ap-hongkong",
		Id:        5,
		ShortName: "hk",
	},
	{
		Name:      "ap-beijing",
		Id:        8,
		ShortName: "bj",
	},
	{
		Name:      "ap-singapore",
		Id:        9,
		ShortName: "sg",
	},
	{
		Name:      "na-siliconvalley",
		Id:        15,
		ShortName: "usw",
	},
	{
		Name:      "ap-chengdu",
		Id:        16,
		ShortName: "cd",
	},
	{
		Name:      "ap-tokyo",
		Id:        25,
		ShortName: "jp",
	},
	{
		Name:      "ap-nanjing",
		Id:        33,
		ShortName: "nj",
	},
	{
		Name:      "eu-frankfurt",
		Id:        17,
		ShortName: "de",
	},
	{
		Name:      "ap-seoul",
		Id:        18,
		ShortName: "kr",
	},
	{
		Name:      "ap-jakarta",
		Id:        72,
		ShortName: "jkt",
	},
	{
		Name:      "sa-saopaulo",
		Id:        74,
		ShortName: "sao",
	},
	{
		Name:      "ap-bangkok",
		Id:        23,
		ShortName: "th",
	},
	{
		Name:      "na-ashburn",
		Id:        22,
		ShortName: "use",
	},
	{
		Name:      "ap-qingyuan",
		Id:        54,
		ShortName: "qy",
	},
}

var regionIdMap = map[string]int{}

var regionShortNameMap = map[string]string{}

func init() {
	for _, item := range regionList {
		regionIdMap[item.Name] = item.Id
		regionShortNameMap[item.Name] = item.ShortName
	}
}

// AllRegionNames ...
func AllRegionNames() []string {
	names := make([]string, len(regionList))
	for i, item := range regionList {
		names[i] = item.Name
	}

	return names
}

// RegionId ...
func RegionId(region string) int {
	return regionIdMap[region]
}

// RegionShortName ...
func RegionShortName(region string) string {
	return regionShortNameMap[region]
}
