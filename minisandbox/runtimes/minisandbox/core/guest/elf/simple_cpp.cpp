#include <numeric>
#include <string>
#include <vector>

#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 1 || argv == nullptr || argv[0] == nullptr || argv[1] != nullptr) {
    return 110;
  }
  const std::vector<int> values{2, 3, 5, 7, 11, 13};
  if (std::accumulate(values.begin(), values.end(), 0) != 41) {
    return 111;
  }
  const std::string output = "ordinary-dynamic-cpp\n";
  if (write(STDOUT_FILENO, output.data(), output.size()) !=
      static_cast<ssize_t>(output.size())) {
    return 112;
  }
  return 45;
}
