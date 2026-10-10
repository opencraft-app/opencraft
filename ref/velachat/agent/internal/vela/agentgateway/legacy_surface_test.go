package agentgateway

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"runtime"
	"testing"
)

func TestGatewayConstructionRequiresSharedHub(t *testing.T) {
	t.Parallel()

	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	file, err := parser.ParseFile(
		token.NewFileSet(),
		filepath.Join(filepath.Dir(currentFile), "gateway.go"),
		nil,
		0,
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if ok && function.Recv == nil && function.Name.Name == "New" {
			t.Fatal("legacy single-Gateway constructor New still exists; use NewHub().Register")
		}
	}
}
