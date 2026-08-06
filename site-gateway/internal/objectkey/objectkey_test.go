package objectkey

import (
	"reflect"
	"strings"
	"testing"
)

const siteID = "ws-a1b2c3d4e5f60718"

func TestCandidates(t *testing.T) {
	prefix := "sites/" + siteID + "/current/"

	cases := []struct {
		name string
		path string
		want []string
	}{
		{"根路径", "/", []string{prefix + "index.html"}},
		{"空路径", "", []string{prefix + "index.html"}},
		{"带扩展名的文件", "/app.js", []string{prefix + "app.js"}},
		{"嵌套文件", "/assets/img/logo.png", []string{prefix + "assets/img/logo.png"}},
		{"目录形式", "/about/", []string{prefix + "about/index.html"}},
		{"无扩展名", "/about", []string{prefix + "about", prefix + "about/index.html"}},
		{"重复斜杠归并", "/a//b.css", []string{prefix + "a/b.css"}},
		{"当前目录标记", "/./app.js", []string{prefix + "app.js"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := Candidates(siteID, tc.path)
			if !ok {
				t.Fatalf("Candidates(%q) 返回非法", tc.path)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Candidates(%q) = %v, 期望 %v", tc.path, got, tc.want)
			}
		})
	}
}

// 目录穿越必须被归并掉：任何请求都不能读到本站点前缀之外的对象，
// 否则一个站点就能读取其他站点的产物和数据。
func TestCandidatesNeverEscapesSitePrefix(t *testing.T) {
	prefix := "sites/" + siteID + "/current/"

	for _, p := range []string{
		"/../../etc/passwd",
		"/../ws-other/current/index.html",
		"/a/../../../../sites/ws-other/data/secret.json",
		"/....//....//x",
		"/a/b/../../../c",
	} {
		got, ok := Candidates(siteID, p)
		if !ok {
			continue
		}
		for _, key := range got {
			if !strings.HasPrefix(key, prefix) {
				t.Fatalf("Candidates(%q) 产生越界 key %q", p, key)
			}
			// 只有独立的 ".." 路径段才是穿越；"...." 之类是合法的字面目录名。
			for _, segment := range strings.Split(key, "/") {
				if segment == ".." {
					t.Fatalf("Candidates(%q) 产生含 .. 路径段的 key %q", p, key)
				}
			}
		}
	}
}

func TestCandidatesRejectsControlCharacters(t *testing.T) {
	for _, p := range []string{"/a\x00b", "/a\nb", "/a\rb"} {
		if _, ok := Candidates(siteID, p); ok {
			t.Fatalf("Candidates(%q) 应拒绝控制字符", p)
		}
	}
}

// 站点是纯静态托管，所有候选 key 必须落在 current/ 之下。
// 任何指向 current/ 之外的 key 都说明有人又给网关加了非静态的对象空间。
func TestCandidatesStayUnderPublishedPrefix(t *testing.T) {
	prefix := PublishedPrefix(siteID)

	for _, p := range []string{"/", "/index.html", "/about", "/assets/app.js", "/__vela/data/notes"} {
		got, ok := Candidates(siteID, p)
		if !ok {
			continue
		}
		for _, key := range got {
			if !strings.HasPrefix(key, prefix) {
				t.Fatalf("Candidates(%q) 产生了 current/ 之外的 key %q", p, key)
			}
		}
	}
}

func TestPrefixesMatchDeployerLayout(t *testing.T) {
	if got := PublishedPrefix(siteID); got != "sites/"+siteID+"/current/" {
		t.Fatalf("PublishedPrefix = %q，与 deployer 的目录布局不一致", got)
	}
	if got := NotFoundKey(siteID); got != "sites/"+siteID+"/current/404.html" {
		t.Fatalf("NotFoundKey = %q", got)
	}
}
