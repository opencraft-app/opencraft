package config

type Configuration interface{}

func NewDefaultConfigurationWithDomain() Configuration {
	return struct{}{}
}
