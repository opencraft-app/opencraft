#define FDB_API_VERSION 730
#include <foundationdb/fdb_c.h>

int main(void) {
	return fdb_select_api_version(FDB_API_VERSION);
}
